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
