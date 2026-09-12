// The markdown AST `parse.ts` produces, `<Markdown>` renders and
// `<RichTextEditor>` edits (it converts to and from ProseMirror nodes, and
// `stringify.ts` writes the result back out). Deliberately small: it is the
// GFM constructs the two components draw, not a general mdast — but it is
// shaped so that growing it stays additive. In particular `component` is the
// MDX direction: `ComponentBlock` is parsed and rendered (docs/prd-mdx.md,
// M1), and `ComponentInline` is still reserved — see the note on it for why
// the inline half needs machinery `<richtext>` does not have yet.
//
// It lives in `src/internal/` because two components read it: shared code no
// app needs on its own yet, per AGENTS.md's "half-step below a shared
// module". `<Markdown>` still re-exports the parser and the types.

/** Inline content, inside a paragraph, heading, list item or table cell. */
export type InlineNode =
  | TextInline
  | CodeInline
  | EmphasisInline
  | LinkInline
  | BreakInline
  | ComponentInline
  | ExpressionInline;

/**
 * `{count}` in the middle of a sentence: unevaluated source, which the
 * renderer compiles against its `scope` and turns into text. Only emitted
 * when `ParseOptions.expressions` says so, so `{braces}` in an ordinary
 * document remain the characters they have always been.
 */
export interface ExpressionInline {
  type: 'expression';
  src: string;
}

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
  /**
   * `[text](href "title")`'s title, when there was one. `<Markdown>` renders
   * none; the editor keeps it, so a document it saves still has it.
   */
  title?: string;
}

/** A hard line break (two trailing spaces, or a trailing backslash). */
export interface BreakInline {
  type: 'break';
}

/**
 * An attribute's value. `literal` is what an attribute string or a `{json}`
 * attribute resolves to at parse time; `expression` holds unevaluated source
 * for the rung that compiles it, so that parsing stays pure and one AST can
 * be rendered against two scopes (docs/prd-mdx.md, M2). The parser emits
 * only `literal` today.
 */
export type AttributeValue =
  { kind: 'literal'; value: unknown } | { kind: 'expression'; src: string };

/**
 * A spread (`{...props}`) is an attribute with no name, so it is keyed
 * `...0`, `...1`, … in the order it appeared. An attribute name cannot start
 * with `.`, so these cannot collide with one; a renderer walking
 * `Object.entries` in insertion order applies each spread where it was
 * written, which is what decides whether it overrides `height` or `height`
 * overrides it.
 */
export const SPREAD_PREFIX = '...';

/**
 * **Still reserved.** `<Badge/>` in the middle of a sentence parses to one of
 * these — except that nothing emits them yet, because nothing can render
 * them: a paragraph is laid out as a single `<richtext>`, and a `TextRun`
 * has no way to say "reserve this much advance width for an element someone
 * else paints". Giving it one is the inline half of MDX and is its own piece
 * of work (baseline alignment, wrapping around the element, and what a
 * selection dragged across it should copy).
 *
 * Kept in the union so the shape stays stable, and so a renderer written
 * against it today cannot be broken by the parser learning to emit them.
 */
export interface ComponentInline {
  type: 'component';
  name: string;
  attributes: Record<string, AttributeValue>;
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
  | RuleBlock
  | ComponentBlock;

/**
 * A component standing where a paragraph would: `<Chart data={…} />` on its
 * own line, or `<Callout>` … `</Callout>` around blocks.
 *
 * Only emitted when `ParseOptions.isComponent` says the name is one — which
 * is what keeps every document that renders today rendering the same way.
 */
export interface ComponentBlock {
  type: 'component';
  name: string;
  attributes: Record<string, AttributeValue>;
  children: BlockNode[];
}

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
  /**
   * The whole info string, trimmed — present only when it says more than
   * `lang` does (```` ```ts title="a.ts" ````, or a language not written in
   * lowercase), so a fence that is just a language parses to the AST it
   * always did. The editor keeps it through a round trip.
   */
  info?: string;
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
  /**
   * Whether `name` is a component this document may use. Absent — the
   * default — means no tag is a component and `<Chart/>` stays the literal
   * text it has always been, so turning MDX on is opt-in and turning it off
   * is byte-for-byte the old behaviour.
   *
   * `<Markdown>` supplies one from its `components` prop. A dotted name
   * (`Card.Header`) is passed through whole; resolving it is the caller's.
   */
  isComponent?: (name: string) => boolean;
  /**
   * Whether `{…}` may hold a JavaScript expression — in an attribute, as a
   * `{...spread}`, or bare in the prose. Off by default, and off is the
   * whole of rung 1: a `{…}` attribute must be JSON, and a brace in a
   * paragraph is a brace.
   *
   * `<Markdown>` turns this on when it is given a `scope`, which is the prop
   * that says the application accepts a document running code. Parsing still
   * evaluates nothing — an expression is kept as source.
   */
  expressions?: boolean;
}
