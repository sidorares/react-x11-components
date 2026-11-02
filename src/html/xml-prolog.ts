// What htmlparser2 reads leniently, read as XML is: the part of an XML parse
// that comes before any node, for `xmlTree` (`dom.ts`). A file of its own
// because the document half of `<Html>` reads XML as well as a page's
// `DOMParser` does, and the serializer beside the engine (`scripts/xml.ts`)
// is the engine's.
import { Parser } from 'htmlparser2';

/** The content types a document is read as XML under (XML Media Types, 3). */
const XML_TYPES = /^(?:text\/xml|application\/xml|[\w.+-]+\/[\w.-]+\+xml)$/;

/** Whether a content type, parameters and all, says XML. */
export function isXmlType(type: string): boolean {
  return XML_TYPES.test(type.split(';')[0].trim().toLowerCase());
}

const NAME = '[A-Za-z_:\\u0080-\\uFFFF][-A-Za-z0-9._:\\u0080-\\uFFFF]*';
const START_TAG = new RegExp(
  `^<(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*/?>$`,
);
const END_TAG = new RegExp(`^</${NAME}\\s*>$`);
/** An attribute, its value with it: a value may say `a = b` twice. */
const ATTRIBUTE = new RegExp(`(${NAME})\\s*=\\s*(?:"[^"<]*"|'[^'<]*')`, 'g');
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
  let text = raw.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
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
  const doctype = /<!DOCTYPE\s+\S+\s+PUBLIC\s+(?:"([^"]*)"|'([^']*)')/.exec(
    text,
  );
  if (doctype && HTML_ENTITY_DTDS.has(doctype[1] ?? doctype[2])) {
    text = text.replace(
      NAMED_REFERENCE,
      (whole: string, name: string | undefined) => {
        if (!name || XML_REFERENCES.has(name)) return whole;
        const value = htmlEntity(name);
        return value
          ? Array.from(value, (c) => `&#${c.codePointAt(0)};`).join('')
          : whole;
      },
    );
  }
  return { text, defaults, wellFormed: wellFormedSyntax(text) };
}

/**
 * The DTDs whose public identifiers stand for HTML's named characters (HTML
 * 13.4): no parser here reads a DTD, and XHTML written with `&nbsp;` under
 * one of these is well-formed in every browser. Under any other doctype, or
 * none, a name nothing declared is the error it is.
 */
const HTML_ENTITY_DTDS = new Set([
  '-//W3C//DTD XHTML 1.0 Transitional//EN',
  '-//W3C//DTD XHTML 1.1//EN',
  '-//W3C//DTD XHTML 1.0 Strict//EN',
  '-//W3C//DTD XHTML 1.0 Frameset//EN',
  '-//W3C//DTD XHTML Basic 1.0//EN',
  '-//W3C//DTD XHTML 1.1 plus MathML 2.0//EN',
  '-//W3C//DTD XHTML 1.1 plus MathML 2.0 plus SVG 1.1//EN',
  '-//W3C//DTD MathML 2.0//EN',
  '-//WAPFORUM//DTD XHTML Mobile 1.0//EN',
]);

/** What the parser decodes itself. */
const XML_REFERENCES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

/** A reference by name, and what no reference is read in, which it leaves
 *  alone by matching first: a comment, a CDATA section, an instruction. */
const NAMED_REFERENCE =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|&([A-Za-z][A-Za-z0-9]*);/g;

const HTML_ENTITIES = new Map<string, string>();

/** One of HTML's named characters, as its parser decodes it, or nothing. */
function htmlEntity(name: string): string {
  let value = HTML_ENTITIES.get(name);
  if (value === undefined) {
    let out = '';
    const reference = `&${name};`;
    new Parser(
      { ontext: (text) => (out += text) },
      { decodeEntities: true },
    ).end(reference);
    value = out === reference ? '' : out;
    HTML_ENTITIES.set(name, value);
  }
  return value;
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
