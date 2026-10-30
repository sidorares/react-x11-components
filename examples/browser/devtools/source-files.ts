// What the Sources panel lists and shows, apart from how it is drawn: the
// page's scripts and style sheets as the document has them — a `<script>`
// and a `<link rel=stylesheet>` by their address, a `<script>` and a
// `<style>` written in the page by their place in it — a minified file set
// out a statement and a rule to a line, and a rule's place in its sheet as
// that place in the text the panel shows.
import * as DomUtils from 'domutils';

import type { Position } from '../../../src/code-editor/index.js';
import type {
  Document,
  Element,
  HtmlRuleSource,
  HtmlSheetSource,
} from '../../../src/html/index.js';
import type { SourceTarget } from './model.js';

export interface SourceFile {
  /** Its address, or `inline:<n>` for one written in the page. */
  id: string;
  kind: 'script' | 'stylesheet';
  /** Where it was loaded from; null for one written in the page. */
  url: string | null;
  /** Its name in the tree: the last part of its path, or `<script> 2`. */
  name: string;
  /** Where the tree files it: its origin, then its path's folders. */
  folders: string[];
  /** The element it is; null for a sheet no element is, which an `@import`
   *  brought in or a page's script made. */
  element: Element | null;
  /** The sheet the document read it as, where it did: its text is what a
   *  rule's place counts in, and needs no reading. */
  sheet?: HtmlSheetSource;
}

/** The scripts a `<script>`'s `type` says are JavaScript. */
const JS_TYPES =
  /^(?:|module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript)$/i;

/** The page's scripts and style sheets, in document order, and then the
 *  sheets the document read that no element in it is (`sheets`,
 *  `HtmlHandle.styleSheets`): what an `@import` brought in, a shadow tree's,
 *  and what a page's script made. */
export function sourcesOf(
  doc: Document,
  base: string | null,
  sheets: readonly HtmlSheetSource[] = [],
): SourceFile[] {
  const out: SourceFile[] = [];
  const seen = new Set<string>();
  let scripts = 0;
  let styles = 0;
  const page = pageFolders(base);
  const resolve = (href: string): string | null => {
    try {
      return new URL(href, base ?? undefined).href;
    } catch {
      return null;
    }
  };
  for (const el of DomUtils.findAll(
    (e) => e.name === 'script' || e.name === 'style' || e.name === 'link',
    doc.children,
  ) as Element[]) {
    if (el.name === 'script') {
      if (!JS_TYPES.test((el.attribs.type ?? '').trim())) continue;
      if (el.attribs.src) {
        const url = resolve(el.attribs.src);
        if (url && !seen.has(url)) {
          seen.add(url);
          out.push(external(url, 'script', el));
        }
      } else {
        scripts += 1;
        out.push({
          id: `inline:script:${scripts}`,
          kind: 'script',
          url: null,
          name: `<script> ${scripts}`,
          folders: page,
          element: el,
        });
      }
    } else if (el.name === 'style') {
      styles += 1;
      out.push({
        id: `inline:style:${styles}`,
        kind: 'stylesheet',
        url: null,
        name: `<style> ${styles}`,
        folders: page,
        element: el,
      });
    } else if (
      /(?:^|\s)stylesheet(?:\s|$)/i.test(el.attribs.rel ?? '') &&
      el.attribs.href
    ) {
      const url = resolve(el.attribs.href);
      if (url && !seen.has(url)) {
        seen.add(url);
        out.push(external(url, 'stylesheet', el));
      }
    }
  }
  const unlisted = new Set(sheets);
  for (const file of out) {
    const sheet = sheets.find((s) => s.element === file.element);
    if (!sheet) continue;
    file.sheet = sheet;
    unlisted.delete(sheet);
  }
  let made = 0;
  for (const sheet of unlisted) {
    if (sheet.url) {
      if (seen.has(sheet.url)) continue;
      seen.add(sheet.url);
      out.push({ ...external(sheet.url, 'stylesheet', sheet.element), sheet });
    } else if (sheet.element) {
      styles += 1;
      out.push({
        id: `inline:style:${styles}`,
        kind: 'stylesheet',
        url: null,
        name: `<style> ${styles}`,
        folders: page,
        element: sheet.element,
        sheet,
      });
    } else {
      made += 1;
      out.push({
        id: `constructed:${made}`,
        kind: 'stylesheet',
        url: null,
        name: `constructed sheet ${made}`,
        folders: page,
        element: null,
        sheet,
      });
    }
  }
  return out;
}

/** The file that shows a sheet: the one the document read it as, or, for a
 *  sheet read before the document's sheets last changed, the one with its
 *  address or its element. */
export function sheetFile(
  files: readonly SourceFile[],
  sheet: HtmlSheetSource,
): SourceFile | null {
  return (
    files.find((f) => f.sheet === sheet) ??
    files.find((f) =>
      sheet.url
        ? f.url === sheet.url
        : f.element && f.element === sheet.element,
    ) ??
    null
  );
}

function external(
  url: string,
  kind: SourceFile['kind'],
  element: Element | null,
): SourceFile {
  let folders: string[] = [];
  let name = url;
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    name = decodeURIComponent(parts.pop() ?? '') || '(index)';
    name += u.search;
    folders = [u.protocol === 'file:' ? 'file://' : u.host, ...parts];
  } catch {
    // an address that is no URL is filed under nothing
  }
  return { id: url, kind, url, name, folders, element };
}

/** Where the page's own inline sources are filed: under its address, as
 *  the document's own file. */
function pageFolders(base: string | null): string[] {
  if (!base) return ['(page)'];
  try {
    const u = new URL(base);
    const parts = u.pathname.split('/').filter(Boolean);
    const file = decodeURIComponent(parts.pop() ?? '') || '(index)';
    return [u.protocol === 'file:' ? 'file://' : u.host, ...parts, file];
  } catch {
    return ['(page)'];
  }
}

/** What a source written in the page holds, without the blank lines and
 *  the indentation it has from where it sits in the markup: a `<style>`
 *  in a `<head>` starts with a line break and is indented under it. */
export function inlineText(file: SourceFile): string {
  return dedented(DomUtils.textContent(file.element!)).text;
}

/** A text without its blank lines at the start and its common indentation,
 *  and how many lines and columns those were. */
function dedented(raw: string): {
  text: string;
  firstLine: number;
  indent: number;
} {
  const firstLine = blankLinesAtStart(raw);
  const lines = raw.trimEnd().split('\n').slice(firstLine);
  let indent = Infinity;
  for (const line of lines) {
    if (line.trim()) indent = Math.min(indent, /^[ \t]*/.exec(line)![0].length);
  }
  if (indent === Infinity) indent = 0;
  return {
    text: lines.map((l) => l.slice(Math.min(indent, l.length))).join('\n'),
    firstLine,
    indent,
  };
}

/** How many lines a text starts with that hold only white space. */
function blankLinesAtStart(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length && /\s/.test(text[i]); i += 1) {
    if (text[i] === '\n') n += 1;
  }
  return n;
}

/** Where a place in `raw` comes to in `dedented(raw).text`. */
function dedentedOffset(raw: string, offset: number): number {
  const { firstLine, indent } = dedented(raw);
  let rest = offset;
  let out = 0;
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const length = lines[i].length;
    if (rest <= length) {
      return i < firstLine ? 0 : out + Math.max(0, rest - indent);
    }
    rest -= length + 1;
    if (i >= firstLine) out += length - Math.min(indent, length) + 1;
  }
  return out;
}

// --- a rule's place -------------------------------------------------------------

/** The longest name a link in the Styles tab shows: past it, the middle
 *  goes, as a browser's tools have it, since a name's ends tell it apart. */
const MOST_NAME = 32;

/** A name no longer than a link shows. */
function shortName(name: string): string {
  if (name.length <= MOST_NAME) return name;
  const end = Math.floor(MOST_NAME / 2);
  return `${name.slice(0, MOST_NAME - end - 1)}…${name.slice(-end)}`;
}

/** Whether what the panel shows of a file is its element's text with its
 *  margins taken off (`inlineText`), rather than its text. */
const isDedented = (file: SourceFile): boolean =>
  file.url === null && file.element !== null;

/** What a rule's link says, `theme.css:12`, by the line the panel numbers
 *  it, and in full, with the file's whole address and the column. */
export function placeName(
  file: SourceFile,
  source: HtmlRuleSource,
): { label: string; title: string } {
  const line =
    source.line - (isDedented(file) ? blankLinesAtStart(source.sheet.text) : 0);
  return {
    label: `${shortName(file.name)}:${line}`,
    title: `${file.url ?? file.name}:${line}:${source.column}`,
  };
}

/** The first of `stops` from `at` that no string, comment or bracket holds,
 *  or the end of the text. */
function scan(text: string, at: number, stops: string): number {
  let i = at;
  while (i < text.length) {
    const c = text[i];
    if (stops.includes(c)) return i;
    if (c === '\\') i += 2;
    else if (c === '"' || c === "'") i = stringEnd(text, i, c);
    else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === '(') i = scan(text, i + 1, ')') + 1;
    else if (c === '[') i = scan(text, i + 1, ']') + 1;
    else i += 1;
  }
  return text.length;
}

/** What is left of `end` without the white space before it. */
function trimmedEnd(text: string, from: number, end: number): number {
  let i = end;
  while (i > from && /\s/.test(text[i - 1])) i -= 1;
  return i;
}

/** What the panel shows for a rule: its selector, which ends at its list's
 *  next `,` or at its block. */
export function ruleTarget(source: HtmlRuleSource): SourceTarget {
  const { sheet, offset } = source;
  return {
    sheet,
    from: offset,
    to: trimmedEnd(sheet.text, offset, scan(sheet.text, offset, ',{')),
  };
}

/**
 * What the panel shows for a declaration of a rule: the one its block has
 * for `property`, the one that reads `value` of two or more — a fallback
 * written ahead of what it falls back from. Read off the text the sheet was
 * parsed from, a piece at a time, since a parsed rule keeps no places of its
 * declarations: what is nested in the block is passed over, and a custom
 * property's value is its own to hold braces. The rule itself where the
 * block has no such declaration.
 */
export function declarationTarget(
  source: HtmlRuleSource,
  property: string,
  value: string,
): SourceTarget {
  const { sheet, offset } = source;
  const text = sheet.text;
  const name = property.startsWith('--') ? property : property.toLowerCase();
  const plain = (v: string) => v.replace(/\s+/g, ' ').trim();
  let last: SourceTarget | null = null;
  let i = scan(text, offset, '{') + 1;
  while (i < text.length) {
    while (i < text.length && /[\s;]/.test(text[i])) i += 1;
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (i >= text.length || text[i] === '}') break;
    const custom = text.startsWith('--', i);
    let end = scan(text, i, ';{}');
    while (custom && text[end] === '{') {
      end = scan(text, closingBrace(text, end) + 1, ';{}');
    }
    if (text[end] === '{') {
      // a nested rule, to the end of its block
      i = closingBrace(text, end) + 1;
      continue;
    }
    const colon = scan(text, i, ':');
    if (colon < end) {
      const written = text.slice(i, colon).trim();
      if ((custom ? written : written.toLowerCase()) === name) {
        const to =
          text[end] === ';' ? end + 1 : trimmedEnd(text, colon + 1, end);
        const target = { sheet, from: i, to };
        const read = text
          .slice(colon + 1, end)
          .replace(/!\s*important\s*$/i, '');
        if (plain(read) === plain(value)) return target;
        last = target;
      }
    }
    i = end + 1;
  }
  return last ?? ruleTarget(source);
}

/** The `}` that closes the block a `{` opens, or the end of the text. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    i = scan(text, i, '{}');
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && --depth === 0) return i;
    i += 1;
  }
  return text.length;
}

/** A place in a text as a line and a column of it. */
function positionAt(text: string, offset: number): Position {
  let line = 0;
  let start = 0;
  for (
    let at = text.indexOf('\n');
    at >= 0 && at < offset;
    at = text.indexOf('\n', at + 1)
  ) {
    line += 1;
    start = at + 1;
  }
  return { line, ch: offset - start };
}

/**
 * Where a target comes to in what the panel shows of its file: `plain`, the
 * text it read, or that set out a line at a time. Its places count in the
 * text the sheet was parsed from, which for one written in the page has its
 * margins (`inlineText`).
 */
export function shownRange(
  file: SourceFile,
  target: SourceTarget,
  plain: string,
  formatted: boolean,
): [Position, Position] {
  const [from, to] = [target.from, target.to].map((at) =>
    isDedented(file) ? dedentedOffset(target.sheet.text, at) : at,
  );
  if (formatted)
    return writeCss(plain, [from, to]).places as [Position, Position];
  return [positionAt(plain, from), positionAt(plain, to)];
}

// --- set out a line at a time ---------------------------------------------------

/** Whether a text looks minified: a line far longer than code is written. */
export function looksMinified(text: string): boolean {
  let longest = 0;
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      longest = Math.max(longest, i - start);
      start = i + 1;
      if (longest > 400) return true;
    }
  }
  return false;
}

/**
 * A style sheet a rule and a declaration to a line, two spaces a block:
 * `{` ends a line and goes in a level, `;` ends a declaration's line, `}`
 * comes out a level on a line of its own. Strings, comments and what is in
 * brackets are copied as they are.
 */
export function formatCss(text: string): string {
  return writeCss(text, []).text;
}

/** `formatCss`, saying where each of `offsets`, in order, comes to. */
function writeCss(
  text: string,
  offsets: readonly number[],
): { text: string; places: Position[] } {
  const out = new Writer();
  const places: Position[] = [];
  let parens = 0;
  for (let i = 0; i < text.length; i += 1) {
    while (places.length < offsets.length && offsets[places.length] <= i) {
      places.push(out.place());
    }
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = stringEnd(text, i, c);
      out.add(text.slice(i, end));
      i = end - 1;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out.add(text.slice(i, stop));
      i = stop - 1;
    } else if (c === '(') {
      parens += 1;
      out.add(c);
    } else if (c === ')') {
      parens = Math.max(0, parens - 1);
      out.add(c);
    } else if (parens) out.add(c);
    else if (c === '{') {
      out.trimEnd();
      out.add(' {');
      out.indent(1);
      out.newline();
    } else if (c === '}') {
      out.indent(-1);
      out.newline();
      out.add('}');
      out.newline();
    } else if (c === ';') {
      out.add(';');
      out.newline();
    } else if (/\s/.test(c)) out.space();
    else out.add(c);
  }
  while (places.length < offsets.length) places.push(out.place());
  return { text: out.text(), places };
}

/**
 * A script set out a statement to a line, two spaces a block. Where the
 * source has a line break it is kept, since a script without semicolons
 * ends a statement there; `{` ends a line and goes in a level, `}` comes
 * out of it, and a `;` outside brackets ends a line. Strings, template
 * literals, comments and regular expressions are copied as they are — a
 * `/` is taken for a regular expression where a value cannot come before
 * it, the guess every formatter makes.
 */
export function formatJs(text: string): string {
  const out = new Writer();
  let parens = 0;
  /** The last thing written that is not white space, and the word it
   *  ends, if any: what tells a `/`. */
  let last = '';
  let word = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = stringEnd(text, i, c);
      out.add(text.slice(i, end));
      i = end - 1;
      last = 'a';
    } else if (c === '`') {
      const end = templateEnd(text, i);
      out.add(text.slice(i, end));
      i = end - 1;
      last = 'a';
    } else if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      out.add(text.slice(i, stop));
      i = stop - 1;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out.add(text.slice(i, stop));
      i = stop - 1;
    } else if (c === '/' && regexCanStart(last, word)) {
      const end = regexEnd(text, i);
      out.add(text.slice(i, end));
      i = end - 1;
      last = 'a';
    } else if (c === '(' || c === '[') {
      parens += 1;
      out.add(c);
      last = c;
    } else if (c === ')' || c === ']') {
      parens = Math.max(0, parens - 1);
      out.add(c);
      last = c;
    } else if (c === '{') {
      out.add('{');
      out.indent(1);
      out.newline();
      last = c;
    } else if (c === '}') {
      out.indent(-1);
      out.newline();
      out.add('}');
      // `}` before `else`, `catch`, `)` or `,` keeps its line
      const next = text.slice(i + 1).match(/^\s*([^\s])/)?.[1] ?? '';
      if (
        !/[),;.\]]/.test(next) &&
        !/^\s*(?:else|catch|finally|while)\b/.test(text.slice(i + 1))
      ) {
        out.newline();
      }
      last = c;
    } else if (c === ';' && !parens) {
      out.add(';');
      out.newline();
      last = c;
    } else if (c === '\n') {
      out.newline();
    } else if (/\s/.test(c)) out.space();
    else {
      out.add(c);
      word = /[\w$]/.test(c) ? (/[\w$]/.test(last) ? word : '') + c : '';
      last = c;
    }
  }
  return out.text();
}

function stringEnd(text: string, at: number, quote: string): number {
  let i = at + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') i += 2;
    else if (c === quote || c === '\n') return i + 1;
    else i += 1;
  }
  return text.length;
}

function templateEnd(text: string, at: number): number {
  let i = at + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') i += 2;
    else if (c === '`') return i + 1;
    else if (c === '$' && text[i + 1] === '{') {
      // a substitution, as far as the brace that closes it
      let depth = 1;
      i += 2;
      while (i < text.length && depth) {
        const d = text[i];
        if (d === '`') i = templateEnd(text, i);
        else if (d === '"' || d === "'") i = stringEnd(text, i, d);
        else {
          if (d === '{') depth += 1;
          else if (d === '}') depth -= 1;
          i += 1;
        }
      }
    } else i += 1;
  }
  return text.length;
}

/** The words after which a `/` starts a regular expression. */
const BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'instanceof',
  'yield',
  'await',
]);

/** Whether a `/` after `last` starts a regular expression rather than
 *  dividing: after nothing, an operator, an opening bracket, a comma, a
 *  colon, or a word like `return` it starts one. */
function regexCanStart(last: string, word: string): boolean {
  if (/[\w$]/.test(last)) return BEFORE_REGEX.has(word);
  return last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last);
}

function regexEnd(text: string, at: number): number {
  let i = at + 1;
  let inClass = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') i += 2;
    else if (c === '\n') return i;
    else {
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        i += 1;
        while (i < text.length && /[a-z]/i.test(text[i])) i += 1;
        return i;
      }
      i += 1;
    }
  }
  return text.length;
}

/** The text a formatter writes, a line at a time, indented by its level. */
class Writer {
  private _lines: string[] = [''];
  private _level = 0;

  add(text: string): void {
    const at = this._lines.length - 1;
    if (!this._lines[at]) this._lines[at] = '  '.repeat(this._level);
    this._lines[at] += text;
  }

  /** Where the next thing added goes. */
  place(): Position {
    const at = this._lines.length - 1;
    return { line: at, ch: this._lines[at].length || this._level * 2 };
  }

  /** One space, where the line has something and does not end in one. */
  space(): void {
    const line = this._lines[this._lines.length - 1];
    if (line.trim() && !line.endsWith(' '))
      this._lines[this._lines.length - 1] += ' ';
  }

  trimEnd(): void {
    const at = this._lines.length - 1;
    this._lines[at] = this._lines[at].trimEnd();
  }

  /** A new line, where the line has something: no line is left empty. */
  newline(): void {
    this.trimEnd();
    if (this._lines[this._lines.length - 1] === '') return;
    this._lines.push('');
  }

  indent(by: number): void {
    this._level = Math.max(0, this._level + by);
  }

  text(): string {
    while (
      this._lines.length > 1 &&
      !this._lines[this._lines.length - 1].trim()
    ) {
      this._lines.pop();
    }
    return this._lines.join('\n');
  }
}
