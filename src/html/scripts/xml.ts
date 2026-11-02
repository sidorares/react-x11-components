// A node as XML (DOM Parsing and Serialization, 3): what `XMLSerializer`
// answers and what `innerHTML` reads in an XML document. The tree keeps an
// element's name as it was written, so a namespace only has to be declared
// where nothing around it does.
import { Comment, Element, ProcessingInstruction, Text } from 'domhandler';
import type { AnyNode, ParentNode } from 'domhandler';

import { HTML_NS, namespaceOf } from './xpath.js';

const VOID = new Set([
  'area',
  'base',
  'basefont',
  'bgsound',
  'br',
  'col',
  'embed',
  'frame',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'menuitem',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const PREFIXES: Record<string, string> = {
  xlink: 'http://www.w3.org/1999/xlink',
  xml: 'http://www.w3.org/XML/1998/namespace',
};

const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (text: string): string =>
  escapeText(text)
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');

export interface XmlWriter {
  /** A doctype's name, public id and system id. */
  doctype(node: AnyNode): [string, string, string];
  /** Whether a text is a CDATA section. */
  cdata(node: Text): boolean;
}

export function serializeXml(root: AnyNode, writer: XmlWriter): string {
  let out = '';
  /** Each prefix's namespace where the walk is, the default's under ''. */
  const write = (node: AnyNode, scope: Map<string, string>): void => {
    if (node instanceof Text) {
      out += writer.cdata(node)
        ? `<![CDATA[${node.data}]]>`
        : escapeText(node.data);
    } else if (node instanceof Comment) out += `<!--${node.data}-->`;
    else if (node instanceof ProcessingInstruction) {
      if (node.name.startsWith('!')) {
        const [name, publicId, systemId] = writer.doctype(node);
        out += `<!DOCTYPE ${name}`;
        if (publicId) out += ` PUBLIC "${publicId}"`;
        if (systemId) out += `${publicId ? '' : ' SYSTEM'} "${systemId}"`;
        out += '>';
      } else out += `<?${node.name.slice(1)} ${node.data}?>`;
    } else if (node instanceof Element) element(node, scope);
    else {
      for (const kid of (node as ParentNode).children ?? []) write(kid, scope);
    }
  };
  const element = (el: Element, outer: Map<string, string>): void => {
    const scope = new Map(outer);
    const ns = namespaceOf(el);
    const html = ns === HTML_NS;
    const name = el.namespace === undefined ? el.name : el.name;
    const colon = name.indexOf(':');
    const prefix = colon < 0 ? '' : name.slice(0, colon);
    const attrs: string[] = [];
    const declared = new Set<string>();
    for (const [key, value] of Object.entries(el.attribs)) {
      if (key === 'xmlns') continue;
      if (key.startsWith('xmlns:')) {
        declared.add(key.slice(6));
        scope.set(key.slice(6), value);
      }
    }
    if (!declared.has(prefix) && (scope.get(prefix) ?? '') !== ns) {
      attrs.push(prefix ? `xmlns:${prefix}="${ns}"` : `xmlns="${ns}"`);
      scope.set(prefix, ns);
    }
    for (const key of Object.keys(el.attribs)) {
      const at = key.indexOf(':');
      const own = at < 0 ? '' : key.slice(0, at);
      if (!own || own === 'xmlns' || own === 'xml' || scope.has(own)) continue;
      if (!PREFIXES[own]) continue;
      attrs.push(`xmlns:${own}="${PREFIXES[own]}"`);
      scope.set(own, PREFIXES[own]);
    }
    for (const [key, value] of Object.entries(el.attribs)) {
      // a declaration of the default namespace is the element's to say,
      // and one that says otherwise, or says it again, goes
      if (key === 'xmlns' && (value !== ns || outer.get('') === ns)) continue;
      attrs.push(`${key}="${escapeAttribute(value)}"`);
    }
    out += `<${name}${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
    if (!el.children.length) {
      if (html && VOID.has(name.toLowerCase())) out += ' />';
      else if (html) out += `></${name}>`;
      else out += '/>';
      return;
    }
    out += '>';
    for (const kid of el.children) write(kid, scope);
    out += `</${name}>`;
  };
  write(root, new Map());
  return out;
}

const NAME = '[A-Za-z_:\\u0080-\\uFFFF][-A-Za-z0-9._:\\u0080-\\uFFFF]*';
const START_TAG = new RegExp(
  `^<(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*/?>$`,
);
const END_TAG = new RegExp(`^</${NAME}\\s*>$`);
const ATTRIBUTE = new RegExp(`(${NAME})\\s*=`, 'g');
const BAD_REFERENCE = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/;
/** A name in a namespace's document: no empty prefix, no empty local part
 *  and one colon at most (Namespaces in XML 1.0, 3). */
const QNAME = /^[^:]+(?::[^:]+)?$/;

/** What a document's prolog says that is no element of it. */
export interface XmlProlog {
  /** The markup, a BOM and its line ends dealt with (XML 1.0, 2.11), and
   *  the entities its internal subset declares read in. */
  text: string;
  wellFormed: boolean;
  /** The attributes an `<!ATTLIST>` gives what does not say them. */
  defaults: Map<string, Map<string, string>>;
}

/**
 * What htmlparser2 reads leniently, read as XML is: a tag that is one, a
 * reference that names something, a version of 1.x, and an internal subset,
 * whose `<!ENTITY>`s and `<!ATTLIST>` defaults are taken here since the
 * parser ends a doctype at its first `>`.
 */
export function readProlog(raw: string): XmlProlog {
  let text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const defaults = new Map<string, Map<string, string>>();
  const entities = new Map<string, string>();
  text = text.replace(
    /<!DOCTYPE\s[^[>]*\[([\s\S]*?)\]\s*>/i,
    (whole: string, subset: string) => {
      for (const m of subset.matchAll(
        /<!ENTITY\s+(\S+)\s+(?:"([^"]*)"|'([^']*)')\s*>/g,
      )) {
        if (!entities.has(m[1])) entities.set(m[1], m[2] ?? m[3]);
      }
      for (const m of subset.matchAll(/<!ATTLIST\s+(\S+)([^>]*)>/g)) {
        let own = defaults.get(m[1]);
        if (!own) defaults.set(m[1], (own = new Map()));
        for (const a of m[2].matchAll(
          /(\S+)\s+(?:\S+|\([^)]*\))\s+(?:#FIXED\s+)?(?:"([^"]*)"|'([^']*)')/g,
        )) {
          if (!own.has(a[1])) own.set(a[1], a[2] ?? a[3]);
        }
      }
      return whole.replace(/\s*\[[\s\S]*\]\s*(?=>)/, '');
    },
  );
  for (const [name, value] of entities) {
    text = text.split(`&${name};`).join(value);
  }
  return { text, defaults, wellFormed: wellFormedSyntax(text) };
}
function wellFormedSyntax(text: string): boolean {
  const version = /^<\?xml\s+version\s*=\s*["']([^"']*)["']/.exec(text);
  if (version && !/^1\.\d+$/.test(version[1])) return false;
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('<', at);
    const run = open < 0 ? text.slice(at) : text.slice(at, open);
    if (BAD_REFERENCE.test(run)) return false;
    if (open < 0) return true;
    let end: number;
    if (text.startsWith('<!--', open)) end = text.indexOf('-->', open) + 2;
    else if (text.startsWith('<![CDATA[', open)) {
      end = text.indexOf(']]>', open) + 2;
    } else if (text.startsWith('<?', open)) end = text.indexOf('?>', open) + 1;
    else if (text.startsWith('<!', open)) end = text.indexOf('>', open);
    else {
      end = open;
      let quote = '';
      for (; end < text.length; end += 1) {
        const c = text[end];
        if (quote) quote = c === quote ? '' : quote;
        else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (end >= text.length) return false;
      const tag = text.slice(open, end + 1);
      if (text[open + 1] === '/') {
        if (!END_TAG.test(tag)) return false;
      } else {
        const m = START_TAG.exec(tag);
        if (!m || !QNAME.test(m[1]) || BAD_REFERENCE.test(m[2])) return false;
        const seen = new Set<string>();
        for (const [, name] of m[2].matchAll(ATTRIBUTE)) {
          if (seen.has(name) || !QNAME.test(name)) return false;
          if (name === 'xmlns:xmlns') return false;
          seen.add(name);
        }
      }
    }
    if (end < open) return false;
    at = end + 1;
  }
  return true;
}
