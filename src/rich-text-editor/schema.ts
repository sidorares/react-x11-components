// The document the editor edits when the app does not bring one: GitHub-
// flavoured markdown, written in ProseMirror's reference vocabulary.
//
// The node and mark names are prosemirror-schema-basic's and
// prosemirror-schema-list's, with prosemirror-markdown's attributes (`order`,
// `tight`, `params`) — so a command, an input rule or a plugin written
// against the reference schema works on this one unchanged. What GFM adds is
// named the way the ecosystem already names it: `strike`, a `checked`
// attribute on `list_item` for task items, and table nodes whose `tableRole`s
// and cell attributes are prosemirror-tables' own, so that package's commands
// can be pointed at a document of this schema.
//
// `parseDOM`/`toDOM` are not decoration either. They are how HTML comes in
// (a paste from a browser, `format="html"`) and goes out (a copy another
// application can read, `format="html"`), through ProseMirror's own
// DOMParser and DOMSerializer over the DOM-shaped shim in `./html.ts`. The
// editor does not *draw* from them — `./render.ts` does that — except for a
// node or mark of an app's schema that nothing more specific describes,
// where `toDOM`'s tag is read as a statement of what the node is.
import { Schema } from 'prosemirror-model';
import type {
  Attrs,
  DOMOutputSpec,
  MarkSpec,
  Node as PMNode,
  NodeSpec,
} from 'prosemirror-model';

/** The DOM surface `getAttrs` reads, whether it is a browser's element or
 *  the shim's — named here so the rules below say what they need. */
interface ElementLike {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  readonly childNodes: ArrayLike<ElementLike>;
  readonly nodeName: string;
  readonly style?: { textAlign?: string; fontWeight?: string };
}

function el(dom: unknown): ElementLike {
  return dom as ElementLike;
}

/** `language-js` on a `<pre>` or the `<code>` in it: how every HTML
 *  highlighter marks a block's language. */
function fenceParams(dom: ElementLike): string {
  const own = dom.getAttribute('data-params');
  if (own != null) return own;
  const classes = [dom.getAttribute('class') ?? ''];
  for (const child of Array.from(dom.childNodes)) {
    if (child.nodeName === 'CODE')
      classes.push(child.getAttribute('class') ?? '');
  }
  for (const cls of classes) {
    const m = /(?:^|\s)(?:language|lang)-(\S+)/.exec(cls);
    if (m) return m[1];
  }
  return '';
}

/**
 * A GFM task item's state, from the HTML GitHub renders one as: a disabled
 * checkbox as the item's first content, directly or inside its first
 * paragraph. `data-checked` is what this schema writes itself. Only the item's
 * own box counts — a nested list's checkboxes are its items' business.
 */
function taskState(dom: ElementLike): boolean | null {
  const flag = dom.getAttribute('data-checked');
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  const kids = Array.from(dom.childNodes);
  const first = kids.find((k) => k.nodeName !== '#text') ?? null;
  const candidates = first
    ? [first, ...(first.nodeName === 'P' ? Array.from(first.childNodes) : [])]
    : [];
  for (const node of candidates) {
    if (
      node.nodeName === 'INPUT' &&
      (node.getAttribute('type') ?? '').toLowerCase() === 'checkbox'
    ) {
      return node.hasAttribute('checked');
    }
  }
  return null;
}

type Align = 'left' | 'center' | 'right' | null;

function alignOf(value: string | null | undefined): Align {
  const v = (value ?? '').trim().toLowerCase();
  return v === 'left' || v === 'center' || v === 'right' ? v : null;
}

/** prosemirror-tables' cell attributes, plus GFM's column alignment. */
const cellAttrs = {
  colspan: { default: 1 },
  rowspan: { default: 1 },
  colwidth: { default: null },
  align: { default: null },
};

function getCellAttrs(dom: unknown): Attrs {
  const e = el(dom);
  const widthAttr = e.getAttribute('data-colwidth');
  const colspan = Number(e.getAttribute('colspan') || 1);
  const widths =
    widthAttr && /^\d+(,\d+)*$/.test(widthAttr)
      ? widthAttr.split(',').map(Number)
      : null;
  return {
    colspan,
    rowspan: Number(e.getAttribute('rowspan') || 1),
    colwidth: widths && widths.length === colspan ? widths : null,
    align: alignOf(e.getAttribute('align') ?? e.style?.textAlign),
  };
}

function setCellAttrs(node: PMNode): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (node.attrs.colspan !== 1) attrs.colspan = String(node.attrs.colspan);
  if (node.attrs.rowspan !== 1) attrs.rowspan = String(node.attrs.rowspan);
  if (node.attrs.colwidth) {
    attrs['data-colwidth'] = (node.attrs.colwidth as number[]).join(',');
  }
  if (node.attrs.align) attrs.style = `text-align: ${node.attrs.align}`;
  return attrs;
}

/** The node specs, in the order the schema ranks them. Exported so an app
 *  can build on them — `new Schema({ nodes: schema.spec.nodes.addBefore(…),
 *  marks: schema.spec.marks })` is ProseMirror's own idiom for that. */
export const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },

  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM: (): DOMOutputSpec => ['p', 0],
  },

  blockquote: {
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: (): DOMOutputSpec => ['blockquote', 0],
  },

  horizontal_rule: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: (): DOMOutputSpec => ['hr'],
  },

  heading: {
    attrs: { level: { default: 1, validate: 'number' } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
      tag: `h${level}`,
      attrs: { level },
    })),
    toDOM: (node): DOMOutputSpec => [`h${node.attrs.level}`, 0],
  },

  code_block: {
    // the whole info string, as prosemirror-markdown keeps it; the language
    // is its first word
    attrs: { params: { default: '', validate: 'string' } },
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    parseDOM: [
      {
        tag: 'pre',
        preserveWhitespace: 'full',
        getAttrs: (dom) => ({ params: fenceParams(el(dom)) }),
      },
    ],
    toDOM: (node): DOMOutputSpec => {
      const params = String(node.attrs.params ?? '');
      const lang = params.split(/\s/, 1)[0];
      return [
        'pre',
        params ? { 'data-params': params } : {},
        ['code', lang ? { class: `language-${lang}` } : {}, 0],
      ];
    },
  },

  ordered_list: {
    attrs: {
      order: { default: 1, validate: 'number' },
      tight: { default: true },
    },
    content: 'list_item+',
    group: 'block',
    parseDOM: [
      {
        tag: 'ol',
        getAttrs: (dom) => {
          const e = el(dom);
          return {
            order: e.hasAttribute('start')
              ? Number(e.getAttribute('start'))
              : 1,
            tight: e.getAttribute('data-tight') !== 'false',
          };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      'ol',
      {
        start: node.attrs.order === 1 ? null : String(node.attrs.order),
        'data-tight': node.attrs.tight ? null : 'false',
      },
      0,
    ],
  },

  bullet_list: {
    attrs: { tight: { default: true } },
    content: 'list_item+',
    group: 'block',
    parseDOM: [
      {
        tag: 'ul',
        getAttrs: (dom) => ({
          tight: el(dom).getAttribute('data-tight') !== 'false',
        }),
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      'ul',
      { 'data-tight': node.attrs.tight ? null : 'false' },
      0,
    ],
  },

  list_item: {
    // `null` for a plain item; `true`/`false` is a GFM task item
    attrs: { checked: { default: null } },
    content: 'paragraph block*',
    defining: true,
    parseDOM: [
      { tag: 'li', getAttrs: (dom) => ({ checked: taskState(el(dom)) }) },
    ],
    toDOM: (node): DOMOutputSpec =>
      node.attrs.checked == null
        ? ['li', 0]
        : [
            'li',
            {
              class: 'task-list-item',
              'data-checked': String(node.attrs.checked),
            },
            [
              'input',
              {
                type: 'checkbox',
                disabled: '',
                checked: node.attrs.checked ? '' : null,
              },
            ],
            ['div', 0],
          ],
  },

  table: {
    content: 'table_row+',
    tableRole: 'table',
    isolating: true,
    group: 'block',
    parseDOM: [{ tag: 'table' }],
    toDOM: (): DOMOutputSpec => ['table', ['tbody', 0]],
  },

  table_row: {
    content: '(table_cell | table_header)*',
    tableRole: 'row',
    parseDOM: [{ tag: 'tr' }],
    toDOM: (): DOMOutputSpec => ['tr', 0],
  },

  table_cell: {
    // GFM cells hold a line of inline content, not blocks: each cell is a
    // textblock, which is what makes a table typable with nothing special
    content: 'inline*',
    attrs: cellAttrs,
    tableRole: 'cell',
    isolating: true,
    parseDOM: [{ tag: 'td', getAttrs: getCellAttrs }],
    toDOM: (node): DOMOutputSpec => ['td', setCellAttrs(node), 0],
  },

  table_header: {
    content: 'inline*',
    attrs: cellAttrs,
    tableRole: 'header_cell',
    isolating: true,
    parseDOM: [{ tag: 'th', getAttrs: getCellAttrs }],
    toDOM: (node): DOMOutputSpec => ['th', setCellAttrs(node), 0],
  },

  text: { group: 'inline' },

  image: {
    inline: true,
    attrs: {
      src: { validate: 'string' },
      alt: { default: null },
      title: { default: null },
    },
    group: 'inline',
    draggable: true,
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom) => {
          const e = el(dom);
          return {
            src: e.getAttribute('src'),
            title: e.getAttribute('title'),
            alt: e.getAttribute('alt'),
          };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => {
      const { src, alt, title } = node.attrs;
      return ['img', { src, alt, title }];
    },
  },

  hard_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: (): DOMOutputSpec => ['br'],
  },
};

/** The mark specs. Order is rank: a mark earlier here wraps a later one when
 *  both cover the same text, which is what puts `code` innermost. */
export const marks: Record<string, MarkSpec> = {
  link: {
    attrs: {
      href: { validate: 'string' },
      title: { default: null },
    },
    // typing at the end of a link continues the text, not the link
    inclusive: false,
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (dom) => {
          const e = el(dom);
          return {
            href: e.getAttribute('href'),
            title: e.getAttribute('title'),
          };
        },
      },
    ],
    toDOM: (mark): DOMOutputSpec => [
      'a',
      { href: mark.attrs.href, title: mark.attrs.title },
      0,
    ],
  },

  em: {
    parseDOM: [
      { tag: 'i' },
      { tag: 'em' },
      { style: 'font-style=italic' },
      { style: 'font-style=normal', clearMark: (m) => m.type.name === 'em' },
    ],
    toDOM: (): DOMOutputSpec => ['em', 0],
  },

  strong: {
    parseDOM: [
      { tag: 'strong' },
      // Google Docs wraps a whole paste in `<b style="font-weight: normal">`
      {
        tag: 'b',
        getAttrs: (dom) => el(dom).style?.fontWeight !== 'normal' && null,
      },
      {
        style: 'font-weight=400',
        clearMark: (m) => m.type.name === 'strong',
      },
      {
        style: 'font-weight',
        getAttrs: (value) =>
          /^(bold(er)?|[5-9]\d{2,})$/.test(value as string) && null,
      },
    ],
    toDOM: (): DOMOutputSpec => ['strong', 0],
  },

  strike: {
    parseDOM: [
      { tag: 's' },
      { tag: 'del' },
      { tag: 'strike' },
      { style: 'text-decoration=line-through' },
      { style: 'text-decoration-line=line-through' },
    ],
    toDOM: (): DOMOutputSpec => ['s', 0],
  },

  code: {
    code: true,
    parseDOM: [{ tag: 'code' }],
    toDOM: (): DOMOutputSpec => ['code', 0],
  },
};

/**
 * The default schema: GFM — paragraphs, six heading levels, quotes, fenced
 * code, rules, bullet/ordered/task lists, tables, images, hard breaks; bold,
 * italic, strikethrough, inline code and links.
 */
export const schema = new Schema({ nodes, marks });
