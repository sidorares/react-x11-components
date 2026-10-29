// What the Sources panel lists and shows, apart from how it is drawn: the
// page's scripts and style sheets as the document has them — a `<script>`
// and a `<link rel=stylesheet>` by their address, a `<script>` and a
// `<style>` written in the page by their place in it — and a minified
// file set out a statement and a rule to a line.
import * as DomUtils from 'domutils';

import type { Document, Element } from '../../../src/html/index.js';

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
  element: Element;
}

/** The scripts a `<script>`'s `type` says are JavaScript. */
const JS_TYPES =
  /^(?:|module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript)$/i;

/** The page's scripts and style sheets, in document order. */
export function sourcesOf(doc: Document, base: string | null): SourceFile[] {
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
  return out;
}

function external(
  url: string,
  kind: SourceFile['kind'],
  element: Element,
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
  const lines = DomUtils.textContent(file.element).trimEnd().split('\n');
  while (lines.length && !lines[0]!.trim()) lines.shift();
  let indent = Infinity;
  for (const line of lines) {
    if (line.trim()) indent = Math.min(indent, /^[ \t]*/.exec(line)![0].length);
  }
  return indent && indent !== Infinity
    ? lines.map((l) => l.slice(Math.min(indent, l.length))).join('\n')
    : lines.join('\n');
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
  const out = new Writer();
  let parens = 0;
  for (let i = 0; i < text.length; i += 1) {
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
  return out.text();
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
