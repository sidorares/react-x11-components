// <Markdown> — a streaming-friendly GFM renderer with selection, built the
// way this package builds everything: composition over public host
// elements, plus one registered element of its own.
//
// **Why not ntk's MarkdownView / HtmlView** (both deprecated): they render
// a whole document as one opaque widget, which forecloses the two things
// this component exists for — cross-block text selection (their layout
// items are unreachable) and per-block streaming updates (any edit relaid
// the whole document). **Why not Streamdown** (evaluated first): its
// pipeline is remark → rehype → DOM with Tailwind classes — an HTML pass
// and a DOM renderer, neither of which exists here. What was worth taking
// was taken: its `remend` package's unterminated-markdown behaviour is
// implemented natively by `parse.ts`, as parser tolerance rather than a
// repair pre-pass (one pass instead of repair-then-reparse).
//
// So: `parse.ts` → AST → this file renders `<box>` structure with one
// `<richtext>` per run of inline text, inside one `selectable` root. During
// streaming, every top-level block whose raw source did not change renders
// from a cache keyed on that raw text, so appending to the tail re-renders
// the tail alone.
//
// **What the selection costs this file: nothing.** react-x11#291 made it a
// core service, so a drag across blocks, the word and block granularities,
// Ctrl+A, Ctrl+C and PRIMARY all arrive with the `selectable` prop on the
// root. What a copy assembles comes from the *layout* — two blocks sharing
// a band of pixels are joined with a tab, one below the last with a newline
// — which is what a table's cells and rows already are on screen, so the
// separator plumbing this renderer used to thread through every cell and
// list line is gone. What is left to say is which parts are not text a
// reader wants: the list markers, with `selectable={false}`.
//
// **MDX (planned, not implemented):** the AST reserves a `component` node
// and the renderer keeps a components-map seam; because a document here is
// ordinary React composition — not a painted widget — interleaving user
// components is structurally possible, in streaming mode too (a pending
// component tag is just one more held-back tail). The parser is the only
// part that would grow. A user component's text joins the selection by
// answering the four accessors in core's docs/extending.md, with nothing to
// register.
import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Icon, useApp, useTheme } from 'react-x11';
import type { DrawnNode, MouseEvent as X11MouseEvent } from 'react-x11';
import { tint } from 'react-x11/style';
import type { Style } from 'react-x11/style';

import type {
  BlockNode,
  Document,
  InlineNode,
  ListBlock,
  TableBlock,
} from './ast.js';
import {
  registerRichText,
  RICHTEXT_ELEMENT,
  useSelectionMenu,
} from '../richtext/index.js';
import type { RichTextProps, TextRun } from '../richtext/index.js';
import {
  codeBlockLook,
  codeBlockRuns,
  codeBlockStyle,
  codeTextStyle,
} from '../codeblock/index.js';
import type { CodeBlockLook } from '../codeblock/index.js';

import { parse } from './parse.js';
import { runsOf, plainTextOf } from './spans.js';
import type { InlineStyles } from './spans.js';
import { useLinkClicks } from './links.js';
import { hx } from './hx.js';

export type {
  BlockNode,
  InlineNode,
  Document as MarkdownDocument,
  ParseOptions,
} from './ast.js';
export { parse, parseInline } from './parse.js';

const h = React.createElement;

// Registration is a shared-module function so `<Code>` can render the same
// element — but the call sits here, at this component's module scope, so
// the tree-shaking contract ("a component registers its element in its own
// index.ts") keeps holding.
registerRichText();

// --- props -----------------------------------------------------------------

export interface MarkdownProps {
  /** The markdown text. Append to it as chunks stream in. */
  source: string;
  /**
   * Whether more source may still arrive (default true). While true, the
   * live tail is rendered friendly: unclosed emphasis/code close
   * implicitly, half-arrived constructs are hidden or held. Set false when
   * the stream ends, and the tail is re-read under final-document rules.
   */
  partial?: boolean;
  /** Mouse selection, Ctrl+A / Ctrl+C, PRIMARY. Default true. */
  selectable?: boolean;
  /**
   * A link was activated. Absent means clicks do nothing — this component
   * never navigates by itself. Images render as their alt text linked to
   * the image source, so they arrive here too.
   */
  onLink?: (href: string, ev: X11MouseEvent<DrawnNode>) => void;
  /** Base text style. Defaults: theme `fontSize` (14), `sans-serif`. */
  fontSize?: number;
  fontFamily?: string;
  /** Code font. Default `'monospace'` — there is no theme token for it. */
  monoFamily?: string;
  /** Selection band fill. Default: theme accent at 35% opacity. */
  selectionColor?: string;
  /** Syntax colouring in fenced code (via ntk's highlighter). Default true. */
  highlight?: boolean;
  /** The root `<box>`'s style — width, padding, margins, `overflow`. */
  style?: Style | Style[];
  'data-testname'?: string;
}

// --- derived look ----------------------------------------------------------

interface Look {
  inline: InlineStyles;
  dim: string;
  border: string;
  headerBg: string;
  headingScales: number[];
  blockGap: number;
  /** Fenced code: shared with `<Code>`, so the two agree in one window. */
  code: CodeBlockLook;
  highlight: boolean;
  /** Cache epoch: two equal keys derive identical elements. */
  key: string;
}

function deriveLook(
  theme: Record<string, unknown>,
  props: MarkdownProps,
): Look {
  const text = String(theme.text ?? '#2d3436');
  const dim = String(theme.textMuted ?? '#7f8c8d');
  const accent = String(theme.accent ?? '#2980b9');
  const border = String(theme.border ?? '#b2bec3');
  const background = String(theme.background ?? 'white');
  const size = props.fontSize ?? Number(theme.fontSize ?? 14);
  const family = props.fontFamily ?? 'sans-serif';
  const monoFamily = props.monoFamily ?? 'monospace';
  const highlight = props.highlight !== false;
  const inline: InlineStyles = {
    family,
    monoFamily,
    size,
    color: text,
    linkColor: accent,
    codeColor: text,
    codeBg: tint(text, 0.08),
  };
  return {
    inline,
    dim,
    border,
    headerBg: tint(text, 0.05),
    headingScales: [1.75, 1.4, 1.2, 1.05, 0.95, 0.85],
    blockGap: Math.round(size * 0.7),
    code: codeBlockLook(theme, { baseSize: size, monoFamily }),
    highlight,
    key: [
      text,
      dim,
      accent,
      border,
      background,
      size,
      family,
      monoFamily,
      highlight,
    ].join('|'),
  };
}

// --- rendering -------------------------------------------------------------

interface RenderCtx {
  look: Look;
  /** `app.fonts`, when real — table column sizing measures through it. */
  fonts: FontsMeasureLike | null;
}

interface FontsMeasureLike {
  layout(
    content: TextRun[] | string,
    style: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): { width: number };
}

function richtext(
  key: string | number,
  runs: TextRun[],
  style?: Style,
  wrap = true,
): ReactElement {
  const props: RichTextProps & { key?: string | number } = { runs };
  if (!wrap) props.wrap = false;
  if (style) props.style = style;
  return h(RICHTEXT_ELEMENT, { ...props, key } as Record<string, unknown>);
}

function inlineStyles(
  ctx: RenderCtx,
  over: Partial<InlineStyles>,
): InlineStyles {
  return { ...ctx.look.inline, ...over };
}

function renderBlocks(blocks: BlockNode[], ctx: RenderCtx): ReactNode[] {
  return blocks.map((b, i) => renderBlock(b, ctx, i));
}

function renderBlock(block: BlockNode, ctx: RenderCtx, key: number): ReactNode {
  const look = ctx.look;
  switch (block.type) {
    case 'paragraph':
      return richtext(key, runsOf(block.children, look.inline));

    case 'heading': {
      const scale = look.headingScales[block.depth - 1] ?? 1;
      const s = inlineStyles(ctx, {
        size: Math.round(look.inline.size * scale),
        weight: 700,
      });
      return richtext(key, runsOf(block.children, s), {
        marginTop: key === 0 ? 0 : Math.round(look.blockGap * 0.6),
      });
    }

    case 'code':
      return renderCode(block.text, block.lang, ctx, key);

    case 'quote': {
      const quoted: RenderCtx = {
        ...ctx,
        look: {
          ...look,
          inline: { ...look.inline, color: look.dim, codeColor: look.dim },
        },
      };
      return hx(
        'box',
        {
          key,
          style: {
            ...STYLES.column,
            gap: look.blockGap,
            borderLeftWidth: 3,
            borderLeftColor: look.border,
            paddingLeft: 10,
          },
        },
        ...renderBlocks(block.children, quoted),
      );
    }

    case 'list':
      return renderList(block, ctx, key);

    case 'rule':
      return hx('box', {
        key,
        style: {
          height: 1,
          backgroundColor: look.border,
          marginTop: 2,
          marginBottom: 2,
        },
      });

    case 'table':
      return renderTable(block, ctx, key);
  }
}

function renderCode(
  text: string,
  lang: string,
  ctx: RenderCtx,
  key: number,
): ReactNode {
  const code = ctx.look.code;
  const runs = codeBlockRuns(text, code, {
    lang,
    highlight: ctx.look.highlight,
  });
  // The block scrolls horizontally rather than wrapping — code is code.
  return hx(
    'box',
    {
      key,
      style: {
        ...codeBlockStyle(code),
        overflow: 'scroll',
        flexDirection: 'column',
      },
    },
    richtext('code', runs, codeTextStyle(code), false),
  );
}

function renderList(list: ListBlock, ctx: RenderCtx, key: number): ReactNode {
  const look = ctx.look;
  const gap = list.tight ? Math.round(look.blockGap * 0.25) : look.blockGap;
  const markerWidth = list.ordered
    ? Math.max(String(list.start + list.items.length - 1).length, 1) *
        Math.ceil(look.inline.size * 0.62) +
      10
    : Math.round(look.inline.size * 1.15);
  // The bullet or the number is chrome, not text: `selectable={false}` keeps
  // it out of what a drag across the list lights up *and* out of what the
  // drag copies. CSS spells this `user-select: none`.
  const markerStyle: Style = { ...STYLES.markerBox, width: markerWidth };
  const items = list.items.map((item, i) => {
    let marker: ReactNode;
    if (item.checked !== null) {
      marker = hx(
        'box',
        { selectable: false, style: markerStyle },
        h(
          'box',
          {
            style: {
              width: 12,
              height: 12,
              borderWidth: 1,
              borderColor: item.checked ? look.inline.linkColor : look.border,
              borderRadius: 3,
              backgroundColor: item.checked ? look.inline.linkColor : undefined,
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: Math.round(look.inline.size * 0.25),
            },
          },
          item.checked
            ? h(Icon, { name: 'check', size: 10, color: 'white' })
            : null,
        ),
      );
    } else {
      marker = hx(
        'box',
        { selectable: false, style: markerStyle },
        hx(
          'text',
          {
            style: {
              color: look.dim,
              fontSize: look.inline.size,
              fontFamily: look.inline.family,
            },
          },
          list.ordered ? `${list.start + i}.` : '•',
        ),
      );
    }
    return hx(
      'box',
      { key: i, style: STYLES.itemRow },
      marker,
      hx(
        'box',
        {
          style: {
            ...STYLES.column,
            gap: Math.round(look.blockGap * 0.4),
            flexGrow: 1,
            flexShrink: 1,
          },
        },
        ...renderBlocks(item.children, ctx),
      ),
    );
  });
  return hx('box', { key, style: { ...STYLES.column, gap } }, ...items);
}

function renderTable(
  table: TableBlock,
  ctx: RenderCtx,
  key: number,
): ReactNode {
  const look = ctx.look;
  const size = look.inline.size;
  const padX = Math.round(size * 0.6);
  const cols = table.align.length;

  // Column widths: max-content per column, measured through the app's font
  // manager, capped so one long cell cannot starve the rest. Without a
  // font manager (the mock backend) an even fallback keeps the shape.
  const widths: number[] = new Array<number>(cols).fill(0);
  const headStyles = inlineStyles(ctx, { weight: 700 });
  const measure = (cells: InlineNode[][], s: InlineStyles): void => {
    for (let c = 0; c < cols; c += 1) {
      let w: number;
      if (ctx.fonts) {
        w = ctx.fonts.layout(runsOf(cells[c], s), {
          family: s.family,
          size: s.size,
        }).width;
      } else {
        w = plainTextOf(cells[c]).length * size * 0.55;
      }
      widths[c] = Math.max(widths[c], Math.min(Math.ceil(w), size * 26));
    }
  };
  measure(table.header, headStyles);
  for (const row of table.rows) measure(row, look.inline);
  for (let c = 0; c < cols; c += 1)
    widths[c] = Math.max(widths[c] + padX * 2 + 2, size * 2.5);

  // Nothing here says "these are cells and those are rows": a copy reads the
  // boxes below, where two cells share a band of pixels and the next row
  // starts under them, and joins them with tabs and newlines accordingly.
  const renderRow = (
    cells: InlineNode[][],
    s: InlineStyles,
    rowKey: string | number,
    bg?: string,
    divided?: boolean,
  ): ReactNode =>
    hx(
      'box',
      {
        key: rowKey,
        style: {
          flexDirection: 'row',
          backgroundColor: bg,
          borderTopWidth: divided ? 1 : undefined,
          borderTopColor: divided ? look.border : undefined,
        },
      },
      ...cells.map((cell, c) =>
        h(
          'box',
          {
            key: c,
            style: {
              width: widths[c],
              paddingLeft: padX,
              paddingRight: padX,
              paddingTop: Math.round(size * 0.35),
              paddingBottom: Math.round(size * 0.35),
            },
          },
          richtext('c', runsOf(cell, s), {
            textAlign: table.align[c] ?? undefined,
            flexGrow: 1,
          }),
        ),
      ),
    );

  const children: ReactNode[] = [];
  children.push(renderRow(table.header, headStyles, 'h', look.headerBg));
  table.rows.forEach((row, r) => {
    children.push(renderRow(row, look.inline, r, undefined, true));
  });

  // A wide table scrolls inside its own viewport instead of forcing the
  // document wider (the root stays vertical-only).
  return hx(
    'box',
    { key, style: { overflow: 'scroll', flexDirection: 'column' } },
    hx(
      'box',
      {
        style: {
          ...STYLES.column,
          borderWidth: 1,
          borderColor: look.border,
          borderRadius: 6,
          alignSelf: 'flex-start',
        },
      },
      ...children,
    ),
  );
}

const STYLES = {
  column: { flexDirection: 'column' },
  itemRow: { flexDirection: 'row' },
  markerBox: { flexDirection: 'row', flexShrink: 0 },
} as const satisfies Record<string, Style>;

// --- the component ---------------------------------------------------------

interface BlockCache {
  epoch: string;
  map: Map<string, ReactNode>;
}

/**
 * A markdown document. Feed it a growing `source` while `partial` and it
 * renders each chunk as it arrives without flashing raw syntax; text is
 * selectable across every block — mouse (double/triple click for
 * word/block), Ctrl+A, Ctrl+C, and X11 PRIMARY on release.
 *
 * ```jsx
 * <box style={{ overflow: 'scroll', flexGrow: 1 }}>
 *   <Markdown source={streamed} partial={stillStreaming}
 *             onLink={(href) => openInBrowser(href)} />
 * </box>
 * ```
 */
export function Markdown(props: MarkdownProps): ReactElement {
  const { source, partial = true, selectable = true, onLink, style } = props;
  // `Theme` is an interface, so it has no implicit index signature — the
  // same widening `hx.ts` documents for the `theme` prop.
  const theme = useTheme() as unknown as Record<string, unknown>;
  const app = useApp() as { fonts?: FontsMeasureLike } | null;

  const links = useLinkClicks(onLink);
  const menu = useSelectionMenu(selectable);

  const look = React.useMemo(
    () => deriveLook(theme, props),
    [
      theme,
      props.fontSize,
      props.fontFamily,
      props.monoFamily,
      props.highlight,
    ],
  );

  const doc: Document = React.useMemo(
    () => parse(source, { partial }),
    [source, partial],
  );

  // Per-block element cache, keyed on the block's raw source (+ whether it
  // is the live tail). Streaming appends re-render only the block that
  // changed; everything else is the same ReactElement, so React bails out
  // and the retained nodes keep their layout caches.
  const cacheRef = React.useRef<BlockCache | null>(null);
  const fonts = app?.fonts ?? null;
  const epoch = `${look.key}|${fonts ? 'f' : '-'}`;
  if (!cacheRef.current || cacheRef.current.epoch !== epoch) {
    cacheRef.current = { epoch, map: new Map() };
  }
  const cache = cacheRef.current;

  const children: ReactNode[] = [];
  {
    const nextMap = new Map<string, ReactNode>();
    const ctx: RenderCtx = { look, fonts };
    for (let i = 0; i < doc.blocks.length; i += 1) {
      const live = partial && i === doc.blocks.length - 1;
      const cacheKey = `${i}|${live ? 'L' : '.'}|${doc.raws[i]}`;
      const hit = cache.map.get(cacheKey) ?? nextMap.get(cacheKey);
      if (hit !== undefined) {
        children.push(hit);
        nextMap.set(cacheKey, hit);
        continue;
      }
      const element = renderBlock(doc.blocks[i], ctx, i);
      children.push(element);
      nextMap.set(cacheKey, element);
    }
    cache.map = nextMap; // old entries fall away with the text that made them
  }

  const rootStyle: Style = {
    flexDirection: 'column',
    gap: look.blockGap,
    alignItems: 'stretch',
  };

  return hx(
    'box',
    {
      style: style
        ? [rootStyle, ...(Array.isArray(style) ? style : [style])]
        : rootStyle,
      // The whole selection: a drag across blocks, word and block
      // granularity, Ctrl+A, Ctrl+C, PRIMARY on release, and one visible
      // selection per application. The surface is a focus target and shows
      // an I-beam because it said this.
      selectable,
      selectionColor: props.selectionColor,
      ...links,
      ...menu,
      'data-testname': props['data-testname'],
    } as Record<string, unknown>,
    ...children,
  );
}
