// The markdown AST `parse.ts` produces and `index.ts` renders. Deliberately
// small: it is the GFM constructs this component draws, not a general
// mdast — but it is shaped so that growing it stays additive. In particular
// `component` is reserved for the MDX direction: a parser extension can emit
// one without the renderer, the selection model or the caches changing shape
// (see "MDX" in index.ts).

/** Inline content, inside a paragraph, heading, list item or table cell. */
export type InlineNode =
  | TextInline
  | CodeInline
  | EmphasisInline
  | LinkInline
  | BreakInline
  | ComponentInline;

/** A run of plain text. Softbreaks arrive collapsed to spaces. */
export interface TextInline {
  type: 'text';
  text: string;
}

/** An inline code span. */
export interface CodeInline {
  type: 'code';
  text: string;
}

/** `strong` is `**`, `em` is `*`, `del` is `~~`. */
export interface EmphasisInline {
  type: 'strong' | 'em' | 'del';
  children: InlineNode[];
}

/**
 * A link, or an image rendered as its alt text (this component draws no
 * remote bitmaps — see index.ts). `href: null` is a link still streaming
 * in: the text is styled as a link but there is nothing to navigate to yet.
 */
export interface LinkInline {
  type: 'link';
  href: string | null;
  /** True when this was `![alt](src)` — the href is the image source. */
  image: boolean;
  children: InlineNode[];
}

/** A hard line break (two trailing spaces, or a trailing backslash). */
export interface BreakInline {
  type: 'break';
}

/**
 * Reserved for MDX: `<Chart data={…} />` would parse to one of these. The
 * current parser never emits it; the renderer maps unknown names to plain
 * text so a future parser upgrade cannot crash an older renderer.
 */
export interface ComponentInline {
  type: 'component';
  name: string;
  attributes: Record<string, string>;
  children: InlineNode[];
}

/** Block-level content. */
export type BlockNode =
  | ParagraphBlock
  | HeadingBlock
  | CodeBlock
  | QuoteBlock
  | ListBlock
  | TableBlock
  | RuleBlock;

export interface ParagraphBlock {
  type: 'paragraph';
  children: InlineNode[];
}

export interface HeadingBlock {
  type: 'heading';
  /** 1–6. Setext `===` is 1, `---` is 2. */
  depth: number;
  children: InlineNode[];
}

/** A fenced or indented code block. Text has no trailing newline. */
export interface CodeBlock {
  type: 'code';
  /** First word of the info string, lowercased — `''` when absent. */
  lang: string;
  text: string;
  /**
   * False when the closing fence has not arrived. During streaming that is
   * the normal state of the last block and not worth signalling to the
   * user; a renderer could badge it if it wanted to.
   */
  closed: boolean;
}

export interface QuoteBlock {
  type: 'quote';
  children: BlockNode[];
}

export interface ListBlock {
  type: 'list';
  ordered: boolean;
  /** Start number of an ordered list; 1 for bullet lists. */
  start: number;
  /**
   * A tight list renders items without paragraph spacing between them —
   * the CommonMark distinction, decided by blank lines in the source.
   */
  tight: boolean;
  items: ListItem[];
}

export interface ListItem {
  /** `null` for a plain item; true/false for a GFM task checkbox. */
  checked: boolean | null;
  children: BlockNode[];
}

export type TableAlign = 'left' | 'center' | 'right' | null;

export interface TableBlock {
  type: 'table';
  /** One entry per column, from the delimiter row. */
  align: TableAlign[];
  /** Header cells. Always exactly `align.length` long. */
  header: InlineNode[][];
  /** Body rows, each padded or truncated to `align.length` cells. */
  rows: InlineNode[][][];
}

export interface RuleBlock {
  type: 'rule';
}

/** What `parse` returns. */
export interface Document {
  blocks: BlockNode[];
  /**
   * The raw source of each top-level block, index-aligned with `blocks`.
   * This is the streaming cache key: a block whose raw text did not change
   * between two parses produced an equal AST, so a renderer can reuse
   * everything it derived from it (see index.ts).
   */
  raws: string[];
}

export interface ParseOptions {
  /**
   * Treat the end of input as "more is coming" (default true): unclosed
   * emphasis, code spans and links that reach the end of the source are
   * completed instead of falling back to literal text, half-arrived
   * constructs (`![alt](…`, a lone trailing `**`, a bare `#`) are hidden,
   * and an ambiguous final line (`---` that could still become a setext
   * underline or a rule) is held back. Pass false for text that is final.
   */
  partial?: boolean;
}
