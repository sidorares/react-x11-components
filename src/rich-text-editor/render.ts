// The document, rendered: one React element per block, keyed by the view's
// block keys, composed from `<box>` and the editor's own text element.
//
// **Composition, not a drawn document**, by the rule AGENTS.md sets for the
// question: the viewport is a scroll rather than a transform, and a
// document's block flow — paragraphs, lists, quotes, a table's rows — is
// what flexbox already lays out, which is how `<Markdown>` draws the same
// content. What composition buys an editor in particular is the extension
// seam: a node view is a React component in the flow, not a picture of one.
//
// **What re-renders, and why nothing else does.** A block is a memoized
// component keyed by its node's *identity* — ProseMirror shares every node
// an edit did not touch, so typing in one paragraph re-renders that
// paragraph and the chain of containers above it, and nothing else. A block
// never receives its position: positions shift on every keystroke before
// them, so a block asks the view for its position when it needs one
// (`getPos`). Decorations and a node selection reach a block through its own
// subscription (`./store.ts`), so neither re-renders the document.
import React, { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import { Icon } from 'react-x11';
import type { DrawnNode, MouseEvent as X11MouseEvent } from 'react-x11';
import type { Style } from 'react-x11/style';
import type { Node as PMNode } from 'prosemirror-model';

import { codeBlockStyle, codeTextStyle } from '../codeblock/index.js';
import { hx } from '../internal/hx.js';
import { setTaskChecked } from './commands.js';
import { buildInline } from './inline.js';
import type { InlineDecoration, InlineWidget } from './inline.js';
import { domTagOf } from './look.js';
import type { BlockContext, EditorLook } from './look.js';
import { TEXT_ELEMENT } from './nodes.js';
import type { KeyedStore } from './store.js';
import type { BlockDecorations, RichEditorView } from './view.js';

const h = React.createElement;

/** What an image standing alone in a paragraph is handed to render — the
 *  editor draws no remote bitmap, the same line `<Markdown>` holds. */
export interface ImageInfo {
  src: string;
  alt: string | null;
  title: string | null;
}

/** What a node view is given. */
export interface NodeViewProps {
  node: PMNode;
  /** Where the node is now. A function, because a node's position moves
   *  with every edit before it and its view is not re-rendered for that. */
  getPos(): number | undefined;
  /** A node selection has selected this node. */
  selected: boolean;
  /** The node's content, rendered — editable text for a textblock, blocks
   *  for a container — for the view to place where it goes. Absent for a
   *  leaf, which has none. */
  children?: ReactNode;
  /** Merge attributes into the node — a checkbox's state, an embed's size. */
  updateAttributes(attrs: Record<string, unknown>): void;
  editable: boolean;
  view: RichEditorView;
}

/** Everything a block renders with. One object per look and seam set, so a
 *  memoized block compares it by identity. */
export interface RenderContext {
  view: RichEditorView;
  look: EditorLook;
  editable: boolean;
  nodeViews?: Readonly<Record<string, ComponentType<NodeViewProps>>>;
  renderImage?: (image: ImageInfo) => ReactNode;
}

const PLAIN: BlockContext = { quote: false, header: false };
const QUOTED: BlockContext = { quote: true, header: false };
const HEADER: BlockContext = { quote: false, header: true };
const QUOTED_HEADER: BlockContext = { quote: true, header: true };

const NO_DECORATIONS: readonly InlineDecoration[] = [];
const NO_WIDGETS: readonly InlineWidget[] = [];

function useKeyed<T>(store: KeyedStore<T>, key: string): T | undefined {
  const subscribe = useCallback(
    (fn: () => void) => store.subscribe(key, fn),
    [store, key],
  );
  const get = useCallback(() => store.get(key), [store, key]);
  return useSyncExternalStore(subscribe, get, get);
}

type Role =
  | 'textblock'
  | 'quote'
  | 'list'
  | 'table'
  | 'rule'
  | 'image'
  | 'atom'
  | 'container';

/** What a block is, for drawing: by name (the reference schema's, then
 *  TipTap's), then by what its own `toDOM` says it is. */
function roleOf(node: PMNode): Role {
  if (node.isTextblock) return 'textblock';
  const name = node.type.name;
  const table = node.type.spec.tableRole;
  if (table === 'table') return 'table';
  switch (name) {
    case 'blockquote':
      return 'quote';
    case 'bullet_list':
    case 'ordered_list':
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return 'list';
    case 'horizontal_rule':
    case 'horizontalRule':
      return 'rule';
    case 'image':
      return 'image';
  }
  const tag = domTagOf(node.type.spec, node)?.tag;
  if (tag === 'blockquote') return 'quote';
  if (tag === 'ul' || tag === 'ol') return 'list';
  if (tag === 'hr') return 'rule';
  if (tag === 'img') return 'image';
  if (tag === 'table') return 'table';
  return node.isLeaf ? 'atom' : 'container';
}

function isOrdered(list: PMNode): boolean {
  const name = list.type.name;
  if (name === 'ordered_list' || name === 'orderedList') return true;
  return domTagOf(list.type.spec, list)?.tag === 'ol';
}

/** The blocks inside `parent`, whose content starts at `contentStart`. */
export function renderBlocks(
  parent: PMNode,
  contentStart: number,
  ctx: RenderContext,
  bctx: BlockContext = PLAIN,
): ReactNode[] {
  const out: ReactNode[] = [];
  parent.forEach((child, offset) => {
    const pos = contentStart + offset;
    const key = ctx.view.keys.keyAt(pos) ?? `p${pos}`;
    out.push(h(BlockView, { key, blockKey: key, node: child, ctx, bctx }));
  });
  return out;
}

interface BlockProps {
  blockKey: string;
  node: PMNode;
  ctx: RenderContext;
  bctx: BlockContext;
}

function sameBlock(a: BlockProps, b: BlockProps): boolean {
  return (
    a.node === b.node &&
    a.ctx === b.ctx &&
    a.blockKey === b.blockKey &&
    a.bctx === b.bctx
  );
}

/** A block, of any kind. */
const BlockView = React.memo(function BlockView(
  props: BlockProps,
): ReactElement | null {
  const { node, blockKey, ctx, bctx } = props;
  const selected = useKeyed(ctx.view.selectedBlocks, blockKey) === true;
  const custom = ctx.nodeViews?.[node.type.name];
  if (custom) return h(NodeViewHost, { ...props, selected, component: custom });
  switch (roleOf(node)) {
    case 'textblock':
      return h(TextblockView, props);
    case 'quote':
      return hx(
        'box',
        {
          style: {
            flexDirection: 'column',
            gap: ctx.look.blockGap,
            borderLeftWidth: 3,
            borderLeftColor: ctx.look.border,
            paddingLeft: 10,
          },
        },
        ...renderBlocks(
          node,
          startOf(ctx, blockKey),
          ctx,
          bctx.header ? QUOTED_HEADER : QUOTED,
        ),
      );
    case 'list':
      return h(ListView, props);
    case 'table':
      return h(TableView, props);
    case 'rule':
      return h(
        AtomBox,
        { blockKey, ctx, selected, style: { paddingTop: 6, paddingBottom: 6 } },
        hx('box', { style: { height: 1, backgroundColor: ctx.look.border } }),
      );
    case 'image':
      return h(AtomBox, { blockKey, ctx, selected }, imageContent(node, ctx));
    case 'atom':
      return h(
        AtomBox,
        { blockKey, ctx, selected },
        hx(
          'text',
          { style: { color: ctx.look.muted, fontSize: ctx.look.size } },
          node.type.spec.leafText?.(node) || node.type.name,
        ),
      );
    default:
      return hx(
        'box',
        { style: { flexDirection: 'column', gap: ctx.look.blockGap } },
        ...renderBlocks(node, startOf(ctx, blockKey), ctx, bctx),
      );
  }
}, sameBlock);

/** Where a block's content starts, now. */
function startOf(ctx: RenderContext, key: string): number {
  return (ctx.view.keys.posOf(key) ?? -1) + 1;
}

function imageContent(node: PMNode, ctx: RenderContext): ReactNode {
  const info: ImageInfo = {
    src: String(node.attrs.src ?? ''),
    alt: typeof node.attrs.alt === 'string' ? node.attrs.alt : null,
    title: typeof node.attrs.title === 'string' ? node.attrs.title : null,
  };
  const drawn = ctx.renderImage?.(info);
  if (drawn != null) return drawn;
  return hx(
    'box',
    {
      style: {
        borderWidth: 1,
        borderColor: ctx.look.border,
        borderRadius: 4,
        padding: 8,
        alignSelf: 'flex-start',
      },
    },
    hx(
      'text',
      { style: { color: ctx.look.muted, fontSize: ctx.look.size } },
      info.alt || info.src || 'image',
    ),
  );
}

interface AtomBoxProps {
  blockKey: string;
  ctx: RenderContext;
  selected: boolean;
  style?: Style;
  children?: ReactNode;
}

/** A block atom: registered with the view, so a press on it selects it, and
 *  outlined while it is selected. */
function AtomBox({
  blockKey,
  ctx,
  selected,
  style,
  children,
}: AtomBoxProps): ReactElement {
  const ref = useCallback(
    (node: unknown) =>
      ctx.view.attachBox(blockKey, (node as DrawnNode | null) ?? null),
    [ctx.view, blockKey],
  );
  return hx(
    'box',
    {
      ref,
      style: {
        flexDirection: 'column',
        borderWidth: 2,
        borderRadius: 4,
        borderColor: selected ? ctx.look.accent : 'transparent',
        ...style,
      },
    },
    children,
  );
}

/** A textblock: the editor's text element, and what its kind wraps it in. */
function TextblockView({
  node,
  blockKey,
  ctx,
  bctx,
}: BlockProps): ReactElement {
  const decorations = useKeyed(ctx.view.decorations, blockKey);
  const look = ctx.look.inline(node, bctx);
  const built = useMemo(
    () =>
      buildInline(
        node,
        look,
        decorations?.inline ?? NO_DECORATIONS,
        decorations?.widgets ?? NO_WIDGETS,
      ),
    [node, look, decorations],
  );
  const code = !!look.code;
  const align = node.attrs.align;
  const text = h(TEXT_ELEMENT, {
    runs: built.runs,
    map: built.map,
    node,
    blockKey,
    host: ctx.view,
    style: {
      ...(code ? codeTextStyle(ctx.look.code) : null),
      ...(align === 'left' || align === 'center' || align === 'right'
        ? { textAlign: align }
        : null),
      flexShrink: 1,
    },
  });
  const box = decorations?.box;
  let out: ReactElement = text;
  if (code) {
    out = hx(
      'box',
      { style: { ...codeBlockStyle(ctx.look.code), flexDirection: 'column' } },
      text,
    );
  } else if (
    node.type.name === 'heading' ||
    /^h[1-6]$/.test(domTagOf(node.type.spec, node)?.tag ?? '')
  ) {
    out = hx(
      'box',
      {
        style: {
          flexDirection: 'column',
          paddingTop: Math.round(ctx.look.blockGap * 0.4),
        },
      },
      text,
    );
  }
  // an image alone in its paragraph is shown, when the app says how
  const only = node.childCount === 1 ? node.firstChild : null;
  if (only?.type.name === 'image' && ctx.renderImage) {
    const drawn = ctx.renderImage({
      src: String(only.attrs.src ?? ''),
      alt: typeof only.attrs.alt === 'string' ? only.attrs.alt : null,
      title: typeof only.attrs.title === 'string' ? only.attrs.title : null,
    });
    if (drawn != null) {
      out = hx(
        'box',
        { style: { flexDirection: 'column', gap: 4 } },
        drawn,
        out,
      );
    }
  }
  if (box?.background) {
    out = hx(
      'box',
      {
        style: {
          flexDirection: 'column',
          backgroundColor: box.background,
          borderRadius: 3,
        },
      },
      out,
    );
  }
  return out;
}

/** A list: its items, each a marker and its blocks. The marker is chrome —
 *  a number, a bullet, or a task's box, which toggles. */
function ListView({ node, blockKey, ctx, bctx }: BlockProps): ReactElement {
  const view = ctx.view;
  const look = ctx.look;
  const ordered = isOrdered(node);
  const start = Number(node.attrs.order ?? node.attrs.start ?? 1);
  const tight = node.attrs.tight !== false;
  const contentStart = startOf(ctx, blockKey);
  const last = start + node.childCount - 1;
  const markerWidth = ordered
    ? Math.max(String(last).length, 1) * Math.ceil(look.size * 0.62) + 10
    : Math.round(look.size * 1.15);
  const items: ReactNode[] = [];
  node.forEach((item, offset, index) => {
    const pos = contentStart + offset;
    const key = view.keys.keyAt(pos) ?? `i${pos}`;
    items.push(
      h(ItemView, {
        key,
        blockKey: key,
        node: item,
        ctx,
        bctx,
        marker: ordered ? `${start + index}.` : '•',
        markerWidth,
      }),
    );
  });
  return hx(
    'box',
    {
      style: {
        flexDirection: 'column',
        gap: tight ? Math.round(look.blockGap * 0.25) : look.blockGap,
      },
    },
    ...items,
  );
}

interface ItemProps extends BlockProps {
  marker: string;
  markerWidth: number;
}

const ItemView = React.memo(
  function ItemView({
    node,
    blockKey,
    ctx,
    bctx,
    marker,
    markerWidth,
  }: ItemProps): ReactElement {
    const look = ctx.look;
    const checked = node.attrs.checked;
    const toggle = useCallback(
      (ev: X11MouseEvent) => {
        // the box is the item's own control: the press is not a caret's
        ev.preventDefault();
        ev.stopPropagation();
        if (!ctx.editable) return;
        const pos = ctx.view.keys.posOf(blockKey);
        const current = ctx.view.keys.nodeOf(blockKey);
        if (pos !== undefined && current)
          ctx.view.run(setTaskChecked(pos, !current.attrs.checked));
      },
      [ctx, blockKey],
    );
    const markerBox =
      typeof checked === 'boolean'
        ? hx(
            'box',
            {
              style: {
                width: markerWidth,
                flexShrink: 0,
                flexDirection: 'row',
              },
              onMouseDown: toggle,
              role: 'checkbox',
              'aria-checked': checked,
            },
            hx(
              'box',
              {
                style: {
                  width: 12,
                  height: 12,
                  borderWidth: 1,
                  borderColor: checked ? look.accent : look.border,
                  borderRadius: 3,
                  backgroundColor: checked ? look.accent : undefined,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginTop: Math.round(look.size * 0.25),
                  cursor: 'default',
                },
              },
              checked
                ? h(Icon, { name: 'check', size: 10, color: look.accentText })
                : null,
            ),
          )
        : hx(
            'box',
            {
              style: {
                width: markerWidth,
                flexShrink: 0,
                flexDirection: 'row',
              },
            },
            hx(
              'text',
              {
                style: {
                  color: look.muted,
                  fontSize: look.size,
                  fontFamily: look.family,
                },
              },
              marker,
            ),
          );
    return hx(
      'box',
      { style: { flexDirection: 'row' } },
      markerBox,
      hx(
        'box',
        {
          style: {
            flexDirection: 'column',
            gap: Math.round(look.blockGap * 0.4),
            flexGrow: 1,
            flexShrink: 1,
          },
        },
        ...renderBlocks(node, startOf(ctx, blockKey), ctx, bctx),
      ),
    );
  },
  (a, b) =>
    sameBlock(a, b) && a.marker === b.marker && a.markerWidth === b.markerWidth,
);

/** A table: rows of cells, columns sharing the width equally — widths that
 *  follow the content would re-measure every cell on every keystroke. */
function TableView({ node, blockKey, ctx, bctx }: BlockProps): ReactElement {
  const look = ctx.look;
  const view = ctx.view;
  const contentStart = startOf(ctx, blockKey);
  const rows: ReactNode[] = [];
  node.forEach((row, rowOffset, rowIndex) => {
    const rowPos = contentStart + rowOffset;
    const rowKey = view.keys.keyAt(rowPos) ?? `r${rowPos}`;
    const cells: ReactNode[] = [];
    row.forEach((cell, cellOffset) => {
      const cellPos = rowPos + 1 + cellOffset;
      const cellKey = view.keys.keyAt(cellPos) ?? `c${cellPos}`;
      const header = cell.type.spec.tableRole === 'header_cell';
      cells.push(
        hx(
          'box',
          {
            key: cellKey,
            style: {
              flexGrow: 1,
              flexBasis: 0,
              minWidth: look.size * 3,
              paddingLeft: Math.round(look.size * 0.6),
              paddingRight: Math.round(look.size * 0.6),
              paddingTop: Math.round(look.size * 0.35),
              paddingBottom: Math.round(look.size * 0.35),
              borderLeftWidth: cellOffset === 0 ? 0 : 1,
              borderLeftColor: look.border,
              flexDirection: 'column',
            },
          },
          cell.isTextblock
            ? h(BlockView, {
                blockKey: cellKey,
                node: cell,
                ctx,
                bctx: header ? (bctx.quote ? QUOTED_HEADER : HEADER) : bctx,
              })
            : renderBlocks(cell, cellPos + 1, ctx, header ? HEADER : bctx),
        ),
      );
    });
    rows.push(
      hx(
        'box',
        {
          key: rowKey,
          style: {
            flexDirection: 'row',
            backgroundColor: rowIndex === 0 ? look.headerBg : undefined,
            borderTopWidth: rowIndex === 0 ? 0 : 1,
            borderTopColor: look.border,
          },
        },
        ...cells,
      ),
    );
  });
  return hx(
    'box',
    {
      style: {
        flexDirection: 'column',
        borderWidth: 1,
        borderColor: look.border,
        borderRadius: 6,
      },
    },
    ...rows,
  );
}

interface NodeViewHostProps extends BlockProps {
  selected: boolean;
  component: ComponentType<NodeViewProps>;
}

/** An app's node view, handed what it needs and nothing positional. */
function NodeViewHost({
  node,
  blockKey,
  ctx,
  bctx,
  selected,
  component,
}: NodeViewHostProps): ReactElement {
  const view = ctx.view;
  const getPos = useCallback(() => view.keys.posOf(blockKey), [view, blockKey]);
  const updateAttributes = useCallback(
    (attrs: Record<string, unknown>) => {
      const pos = view.keys.posOf(blockKey);
      const current = view.keys.nodeOf(blockKey);
      if (pos === undefined || !current) return;
      view.dispatch(
        view.state.tr.setNodeMarkup(pos, undefined, {
          ...current.attrs,
          ...attrs,
        }),
      );
    },
    [view, blockKey],
  );
  let children: ReactNode;
  if (node.isTextblock)
    children = h(TextblockView, { node, blockKey, ctx, bctx });
  else if (!node.isLeaf)
    children = renderBlocks(node, startOf(ctx, blockKey), ctx, bctx);
  const inner = h(component, {
    node,
    getPos,
    selected,
    children,
    updateAttributes,
    editable: ctx.editable,
    view,
  });
  // a leaf is something a press selects, so the view has to know its box
  return node.isLeaf ? h(AtomBox, { blockKey, ctx, selected }, inner) : inner;
}

export type { BlockDecorations };
