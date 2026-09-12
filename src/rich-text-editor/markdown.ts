// Markdown in and out of the editor's document, through the markdown AST.
//
// `src/internal/markdown/parse.ts` is `<Markdown>`'s own parser — GFM, with
// the same tolerance and the same deliberate deviations — so a note written
// in the editor and one rendered by `<Markdown>` agree about what the text
// means, and this file is only the translation between two trees: the AST's
// nested inline nodes and ProseMirror's flat mark sets. Going out, the flat
// marks are regrouped into the nesting that needs the fewest delimiters, and
// `stringify.ts` writes it.
//
// It speaks the reference schema's names (`./schema.ts`) — and TipTap's
// camelCase ones as well, so a schema built from TipTap's extensions round-
// trips through markdown without a codec of its own. A node neither knows is
// kept as what it contains: a textblock's text, a container's blocks. A
// schema with nodes markdown cannot say should pass a codec (`markdown`) or
// use `format="html"`, which goes through the schema's own `toDOM`.
import type {
  Attrs,
  Mark,
  MarkType,
  Node as PMNode,
  NodeType,
  Schema,
} from 'prosemirror-model';

import { parse } from '../internal/markdown/parse.js';
import { stringify } from '../internal/markdown/stringify.js';
import type {
  BlockNode,
  InlineNode,
  LinkInline,
  ListItem,
  TableAlign,
} from '../internal/markdown/ast.js';

/** How a document becomes markdown and back — the default one, or an app's
 *  for a schema this one does not understand. */
export interface MarkdownCodec {
  parse(source: string): PMNode;
  serialize(doc: PMNode): string;
}

/** The codec for `schema`: the reference names, TipTap's, or both. */
export function markdownCodec(schema: Schema): MarkdownCodec {
  return {
    parse: (source) => docFromMarkdown(schema, source),
    serialize: (doc) => markdownFromDoc(doc),
  };
}

// --- names -------------------------------------------------------------------

/** The spellings each thing goes by: ProseMirror's reference schemas first,
 *  then TipTap's. */
const NODE_NAMES = {
  paragraph: ['paragraph'],
  heading: ['heading'],
  code: ['code_block', 'codeBlock'],
  quote: ['blockquote'],
  bullet: ['bullet_list', 'bulletList'],
  ordered: ['ordered_list', 'orderedList'],
  task: ['task_list', 'taskList'],
  item: ['list_item', 'listItem'],
  taskItem: ['task_item', 'taskItem'],
  rule: ['horizontal_rule', 'horizontalRule'],
  table: ['table'],
  row: ['table_row', 'tableRow'],
  cell: ['table_cell', 'tableCell'],
  header: ['table_header', 'tableHeader'],
  image: ['image'],
  hardBreak: ['hard_break', 'hardBreak'],
} as const;

const MARK_NAMES = {
  strong: ['strong', 'bold'],
  em: ['em', 'italic'],
  del: ['strike', 's', 'del', 'strikethrough'],
  code: ['code'],
  link: ['link'],
} as const;

type NodeRole = keyof typeof NODE_NAMES;
type MarkRole = keyof typeof MARK_NAMES;

const NODE_ROLE = new Map<string, NodeRole>();
for (const [role, names] of Object.entries(NODE_NAMES)) {
  for (const name of names) NODE_ROLE.set(name, role as NodeRole);
}
const MARK_ROLE = new Map<string, MarkRole>();
for (const [role, names] of Object.entries(MARK_NAMES)) {
  for (const name of names) MARK_ROLE.set(name, role as MarkRole);
}

function nodeType(schema: Schema, role: NodeRole): NodeType | undefined {
  for (const name of NODE_NAMES[role]) {
    const type = schema.nodes[name];
    if (type) return type;
  }
  return undefined;
}

function markType(schema: Schema, role: MarkRole): MarkType | undefined {
  for (const name of MARK_NAMES[role]) {
    const type = schema.marks[name];
    if (type) return type;
  }
  return undefined;
}

/** Only the attributes `type` declares — TipTap's `orderedList` calls the
 *  start `start` where prosemirror-markdown calls it `order`, and a node
 *  should not be handed a name it does not have. */
function attrsFor(type: NodeType, wanted: Record<string, unknown>): Attrs {
  const out: Record<string, unknown> = {};
  const spec = type.spec.attrs ?? {};
  for (const [name, value] of Object.entries(wanted)) {
    if (name in spec) out[name] = value;
  }
  return out;
}

// --- markdown → document -----------------------------------------------------

/** Parse markdown into a document of `schema`. Never throws on content: what
 *  the schema cannot hold is kept as the nearest thing it can. */
export function docFromMarkdown(schema: Schema, source: string): PMNode {
  const ast = parse(source, { partial: false });
  const blocks = blocksToNodes(schema, ast.blocks);
  return (
    schema.topNodeType.createAndFill(null, blocks) ??
    schema.topNodeType.createAndFill()!
  );
}

function blocksToNodes(schema: Schema, blocks: readonly BlockNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const block of blocks) out.push(...blockToNodes(schema, block));
  return out;
}

function paragraph(schema: Schema, content: PMNode[]): PMNode {
  const type =
    nodeType(schema, 'paragraph') ??
    schema.topNodeType.contentMatch.defaultType!;
  return type.createAndFill(null, content) ?? type.create();
}

function blockToNodes(schema: Schema, block: BlockNode): PMNode[] {
  switch (block.type) {
    case 'paragraph':
      return [paragraph(schema, inlineToNodes(schema, block.children, []))];

    case 'heading': {
      const type = nodeType(schema, 'heading');
      const content = inlineToNodes(schema, block.children, []);
      if (!type) return [paragraph(schema, content)];
      return [
        type.createAndFill(attrsFor(type, { level: block.depth }), content) ??
          paragraph(schema, content),
      ];
    }

    case 'code': {
      const type = nodeType(schema, 'code');
      const text = block.text ? [schema.text(block.text)] : [];
      if (!type) return [paragraph(schema, text)];
      const info = block.info ?? block.lang;
      return [
        type.create(
          attrsFor(type, {
            params: info,
            language: block.lang || null,
          }),
          text,
        ),
      ];
    }

    case 'quote': {
      const type = nodeType(schema, 'quote');
      const children = blocksToNodes(schema, block.children);
      if (!type) return children;
      return [
        type.createAndFill(
          null,
          children.length ? children : [paragraph(schema, [])],
        ) ?? paragraph(schema, []),
      ];
    }

    case 'list':
      return listToNodes(
        schema,
        block.ordered,
        block.start,
        block.tight,
        block.items,
      );

    case 'table': {
      const table = nodeType(schema, 'table');
      const row = nodeType(schema, 'row');
      const cell = nodeType(schema, 'cell');
      const header = nodeType(schema, 'header') ?? cell;
      if (!table || !row || !cell || !header) {
        // no tables here: a row per paragraph, cells kept apart by a bar
        return [block.header, ...block.rows].map((cells) =>
          paragraph(
            schema,
            cells.flatMap((c, i) => [
              ...(i > 0 ? [schema.text(' | ')] : []),
              ...inlineToNodes(schema, c, []),
            ]),
          ),
        );
      }
      const makeRow = (cells: InlineNode[][], type: NodeType): PMNode =>
        row.create(
          null,
          cells.map(
            (c, i) =>
              type.createAndFill(
                attrsFor(type, { align: block.align[i] ?? null }),
                inlineToNodes(schema, c, []),
              ) ?? type.createAndFill()!,
          ),
        );
      return [
        table.create(null, [
          makeRow(block.header, header),
          ...block.rows.map((r) => makeRow(r, cell)),
        ]),
      ];
    }

    case 'rule': {
      const type = nodeType(schema, 'rule');
      return type ? [type.create()] : [];
    }

    case 'component':
      return blocksToNodes(schema, block.children);
  }
}

function listToNodes(
  schema: Schema,
  ordered: boolean,
  start: number,
  tight: boolean,
  items: readonly ListItem[],
): PMNode[] {
  const isTask =
    !ordered && items.length > 0 && items.every((i) => i.checked !== null);
  // TipTap keeps task items in a list type of their own; the reference
  // schema (and this one) keeps them in a bullet list, as GFM does
  const taskList = isTask ? nodeType(schema, 'task') : undefined;
  const listType = taskList ?? nodeType(schema, ordered ? 'ordered' : 'bullet');
  const itemType =
    (taskList ? nodeType(schema, 'taskItem') : undefined) ??
    nodeType(schema, 'item');
  if (!listType || !itemType) {
    return items.flatMap((item) => blocksToNodes(schema, item.children));
  }
  const nodes = items.map((item) => {
    let children = blocksToNodes(schema, item.children);
    // an item's first child must be a paragraph (`paragraph block*`); one
    // that opened with a fence or a nested list gets an empty paragraph in
    // front of it, which is what that markdown looks like anyway
    const first = itemType.contentMatch.defaultType;
    if (first && (children.length === 0 || children[0].type !== first)) {
      children = [first.createAndFill()!, ...children];
    }
    return (
      itemType.createAndFill(
        attrsFor(itemType, { checked: item.checked }),
        children,
      ) ?? itemType.createAndFill()!
    );
  });
  return [
    listType.create(attrsFor(listType, { order: start, start, tight }), nodes),
  ];
}

function withMark(
  marks: readonly Mark[],
  type: MarkType | undefined,
  attrs?: Attrs,
): readonly Mark[] {
  return type ? type.create(attrs).addToSet(marks) : marks;
}

function plainOf(nodes: readonly InlineNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text' || node.type === 'code') out += node.text;
    else if (node.type === 'break') out += ' ';
    else if ('children' in node) out += plainOf(node.children);
  }
  return out;
}

function inlineToNodes(
  schema: Schema,
  nodes: readonly InlineNode[],
  marks: readonly Mark[],
): PMNode[] {
  const out: PMNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        if (node.text) out.push(schema.text(node.text, marks));
        break;
      case 'code':
        if (node.text) {
          out.push(
            schema.text(node.text, withMark(marks, markType(schema, 'code'))),
          );
        }
        break;
      case 'strong':
        out.push(
          ...inlineToNodes(
            schema,
            node.children,
            withMark(marks, markType(schema, 'strong')),
          ),
        );
        break;
      case 'em':
        out.push(
          ...inlineToNodes(
            schema,
            node.children,
            withMark(marks, markType(schema, 'em')),
          ),
        );
        break;
      case 'del':
        out.push(
          ...inlineToNodes(
            schema,
            node.children,
            withMark(marks, markType(schema, 'del')),
          ),
        );
        break;
      case 'link':
        out.push(...linkToNodes(schema, node, marks));
        break;
      case 'break': {
        const type = nodeType(schema, 'hardBreak');
        if (type) out.push(type.create(null, null, marks));
        else out.push(schema.text(' ', marks));
        break;
      }
      case 'expression':
        out.push(schema.text(`{${node.src}}`, marks));
        break;
      case 'component':
        out.push(...inlineToNodes(schema, node.children, marks));
        break;
    }
  }
  return out;
}

function linkToNodes(
  schema: Schema,
  node: LinkInline,
  marks: readonly Mark[],
): PMNode[] {
  if (node.image) {
    const type = nodeType(schema, 'image');
    const alt = plainOf(node.children);
    if (type && node.href !== null) {
      return [
        type.create(
          attrsFor(type, {
            src: node.href,
            alt: alt || null,
            title: node.title ?? null,
          }),
          null,
          marks,
        ),
      ];
    }
    return alt ? [schema.text(alt, marks)] : [];
  }
  const link = markType(schema, 'link');
  const inner =
    node.href !== null && link
      ? withMark(marks, link, { href: node.href, title: node.title ?? null })
      : marks;
  return inlineToNodes(schema, node.children, inner);
}

// --- document → markdown -----------------------------------------------------

/** Write a document of the reference (or TipTap's) schema as markdown. */
export function markdownFromDoc(doc: PMNode): string {
  return stringify(blocksOf(doc));
}

function blocksOf(parent: PMNode): BlockNode[] {
  const out: BlockNode[] = [];
  parent.forEach((child) => out.push(...nodeToBlocks(child)));
  return out;
}

function nodeToBlocks(node: PMNode): BlockNode[] {
  switch (NODE_ROLE.get(node.type.name)) {
    case 'paragraph':
      return [{ type: 'paragraph', children: inlineOf(node) }];
    case 'heading':
      return [
        {
          type: 'heading',
          depth: Number(node.attrs.level ?? 1),
          children: inlineOf(node),
        },
      ];
    case 'code': {
      const info = String(
        node.attrs.params ?? node.attrs.language ?? '',
      ).trim();
      const lang = (info.split(/[ \t]/, 1)[0] ?? '').toLowerCase();
      return [
        {
          type: 'code',
          lang,
          ...(info !== lang ? { info } : null),
          text: node.textContent,
          closed: true,
        },
      ];
    }
    case 'quote':
      return [{ type: 'quote', children: blocksOf(node) }];
    case 'bullet':
    case 'ordered':
    case 'task': {
      const ordered = NODE_ROLE.get(node.type.name) === 'ordered';
      const items: ListItem[] = [];
      node.forEach((item) => {
        const checked = item.attrs.checked;
        items.push({
          checked:
            typeof checked === 'boolean'
              ? checked
              : NODE_ROLE.get(item.type.name) === 'taskItem'
                ? false
                : null,
          children: blocksOf(item),
        });
      });
      return [
        {
          type: 'list',
          ordered,
          start: Number(node.attrs.order ?? node.attrs.start ?? 1),
          tight: node.attrs.tight !== false,
          items,
        },
      ];
    }
    case 'rule':
      return [{ type: 'rule' }];
    case 'table':
      return [tableOf(node)];
    default:
      if (node.isTextblock)
        return [{ type: 'paragraph', children: inlineOf(node) }];
      if (!node.isLeaf) return blocksOf(node);
      return [];
  }
}

function tableOf(table: PMNode): BlockNode {
  const grid: InlineNode[][][] = [];
  const align: TableAlign[] = [];
  table.forEach((row) => {
    const cells: InlineNode[][] = [];
    row.forEach((cell) => {
      const col = cells.length;
      if (align[col] === undefined) {
        const a = cell.attrs.align;
        align[col] = a === 'left' || a === 'center' || a === 'right' ? a : null;
      }
      cells.push(cellInline(cell));
    });
    grid.push(cells);
  });
  const width = Math.max(1, ...grid.map((r) => r.length));
  const pad = (r: InlineNode[][]): InlineNode[][] =>
    Array.from({ length: width }, (_, i) => r[i] ?? []);
  for (let i = 0; i < width; i++) align[i] ??= null;
  return {
    type: 'table',
    align: align.slice(0, width),
    header: pad(grid[0] ?? []),
    rows: grid.slice(1).map(pad),
  };
}

/** A cell's content as one line: its own inline content, or — for a schema
 *  whose cells hold blocks — each textblock's, a space between. */
function cellInline(cell: PMNode): InlineNode[] {
  if (cell.isTextblock) return inlineOf(cell);
  const out: InlineNode[] = [];
  cell.descendants((node) => {
    if (!node.isTextblock) return true;
    if (out.length) out.push({ type: 'text', text: ' ' });
    out.push(...inlineOf(node));
    return false;
  });
  return out;
}

interface OpenMark {
  mark: Mark;
  children: InlineNode[];
}

/**
 * A textblock's flat marked runs, as the AST's nested inline tree.
 *
 * The open marks are a stack. At each child, every mark the child no longer
 * carries is closed — with everything opened inside it, to be reopened —
 * and the marks it adds are opened, **the longest-running outermost**, so
 * that "bold, then bold italic, then bold" is one bold around an italic and
 * not two bolds either side of one: two runs of `**` meeting reads back as
 * one run of four. Code is never a container: it is the leaf, innermost,
 * where markdown needs it.
 */
function inlineOf(block: PMNode): InlineNode[] {
  const children: PMNode[] = [];
  block.forEach((child) => children.push(child));
  const containers = children.map((child) =>
    child.marks.filter((m) => {
      const role = MARK_ROLE.get(m.type.name);
      return role !== undefined && role !== 'code';
    }),
  );
  /** The last index, from `i` on, through which `mark` runs unbroken. */
  const runsTo = (i: number, mark: Mark): number => {
    let j = i;
    while (j + 1 < children.length && mark.isInSet(containers[j + 1])) j++;
    return j;
  };

  const root: InlineNode[] = [];
  const stack: OpenMark[] = [];
  const top = (): InlineNode[] =>
    stack.length ? stack[stack.length - 1].children : root;

  children.forEach((child, i) => {
    const want = containers[i];
    let keep = 0;
    while (keep < stack.length && stack[keep].mark.isInSet(want)) keep++;
    stack.length = keep;
    // Longest-running first; between two that run as far, emphasis outside
    // a link — `~~[ a](u)~~` can hold the space at the link's edge, while
    // `[~~ a~~](u)` would have to move it out of the strikethrough.
    const opening = want
      .filter((m) => !stack.some((open) => open.mark.eq(m)))
      .map((m, order) => ({
        m,
        end: runsTo(i, m),
        link: MARK_ROLE.get(m.type.name) === 'link' ? 1 : 0,
        order,
      }))
      .sort((a, b) => b.end - a.end || a.link - b.link || a.order - b.order);
    for (const { m } of opening) {
      const inner: InlineNode[] = [];
      top().push(containerOf(m, inner));
      stack.push({ mark: m, children: inner });
    }
    const code = child.marks.some((m) => MARK_ROLE.get(m.type.name) === 'code');
    top().push(...leafOf(child, code));
  });
  return root;
}

function containerOf(mark: Mark, children: InlineNode[]): InlineNode {
  switch (MARK_ROLE.get(mark.type.name)) {
    case 'strong':
      return { type: 'strong', children };
    case 'em':
      return { type: 'em', children };
    case 'del':
      return { type: 'del', children };
    default: {
      const title = mark.attrs.title;
      return {
        type: 'link',
        href: String(mark.attrs.href ?? ''),
        image: false,
        children,
        ...(typeof title === 'string' && title ? { title } : null),
      };
    }
  }
}

function leafOf(node: PMNode, code: boolean): InlineNode[] {
  if (node.isText) {
    const text = node.text ?? '';
    return [code ? { type: 'code', text } : { type: 'text', text }];
  }
  const role = NODE_ROLE.get(node.type.name);
  if (role === 'hardBreak') return [{ type: 'break' }];
  if (role === 'image') {
    const alt = node.attrs.alt;
    const title = node.attrs.title;
    return [
      {
        type: 'link',
        href: String(node.attrs.src ?? ''),
        image: true,
        children:
          typeof alt === 'string' && alt ? [{ type: 'text', text: alt }] : [],
        ...(typeof title === 'string' && title ? { title } : null),
      },
    ];
  }
  // an inline node markdown has no word for: its text, if it has any
  const leaf = node.type.spec.leafText?.(node) ?? node.textContent;
  return leaf ? [{ type: 'text', text: leaf }] : [];
}

// --- plain text ----------------------------------------------------------------

/** One textblock per line, both ways — `format="text"`. */
export function docFromText(schema: Schema, text: string): PMNode {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return (
    schema.topNodeType.createAndFill(
      null,
      lines.map((line) => paragraph(schema, line ? [schema.text(line)] : [])),
    ) ?? schema.topNodeType.createAndFill()!
  );
}

export function textFromDoc(doc: PMNode): string {
  return doc.textBetween(0, doc.content.size, '\n', (leaf) =>
    NODE_ROLE.get(leaf.type.name) === 'hardBreak'
      ? '\n'
      : (leaf.type.spec.leafText?.(leaf) ?? ''),
  );
}
