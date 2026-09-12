// Compiling `{…}` — the rung where a document runs code (docs/prd-mdx.md,
// M2), and the one place in this component that calls `new Function`.
//
// It is a small file on purpose. Everything hard about MDX expressions was
// decided elsewhere: the parser holds an expression as *source* rather than
// a value, so a parse is pure and one AST can be rendered against two
// scopes; and `<Markdown>` only turns any of this on when the application
// passes a `scope`, which is the prop that means "I accept that this
// document may compute". What is left here is compiling the source once, and
// not letting a half-typed expression take down a document that is still
// being typed.
//
// **There is no sandbox.** `new Function` runs in this process with this
// process's authority. That is why the gate is a prop, and why the docs say
// in as few words as they can: do not pass `scope` alongside a document you
// did not write.

import type {
  BlockNode,
  Document,
  InlineNode,
} from '../internal/markdown/ast.js';

/** A compiled expression, or null if it would not compile at all. */
type Compiled = ((...args: unknown[]) => unknown) | null;

/**
 * Keyed on the scope's shape *and* the source, because a compiled function
 * closes over its parameter names. Bounded the way `richtext/node.ts` bounds
 * its layout cache: a streaming document recompiles its tail on every chunk,
 * and an unbounded map would hold every intermediate spelling of an
 * expression that was being typed.
 */
const CACHE = new Map<string, Compiled>();
const LIMIT = 256;

let warned = false;

/**
 * Say so, once, when an expression does not work out. A document that
 * silently loses a value should not be a mystery — and saying it on every
 * frame of a streaming render would be worse than saying nothing.
 *
 * `process` and `console` come off `globalThis` because `src/` compiles with
 * `types: []` — a Node global that wandered in would fail the build rather
 * than become an implicit `@types/node` dependency.
 */
function warnFailed(src: string, error: unknown): void {
  if (warned) return;
  warned = true;
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    console?: { warn(message: string, ...rest: unknown[]): void };
  };
  if (g.process?.env?.NODE_ENV === 'production') return;
  g.console?.warn(
    '@react-x11/components: a markdown expression did not evaluate, so it ' +
      `rendered as nothing: {${src}}`,
    error,
  );
}

function compile(src: string, keys: readonly string[]): Compiled {
  const key = `${keys.join(',')} ${src}`;
  const hit = CACHE.get(key);
  if (hit !== undefined) return hit;
  let compiled: Compiled = null;
  try {
    // `return (…)` rather than a bare body: an expression is what the braces
    // promised, and the parentheses keep an object literal an object literal
    // rather than a block.
    compiled = new Function(...keys, `"use strict"; return (${src});`) as (
      ...args: unknown[]
    ) => unknown;
  } catch (error) {
    // A syntax error is the ordinary state of an expression being typed.
    warnFailed(src, error);
  }
  if (CACHE.size >= LIMIT) CACHE.clear();
  CACHE.set(key, compiled);
  return compiled;
}

/**
 * What a renderer calls: source in, value out, `undefined` if it did not
 * work. Never throws — a document being edited is full of expressions that
 * do not work yet.
 */
export type Evaluate = (src: string) => unknown;

/**
 * An evaluator over `scope`. The keys are read once, so a scope mutated in
 * place after this is called keeps its old shape — the same contract every
 * other seam here has, and the reason the prop doc asks for a stable object.
 */
export function evaluator(scope: Record<string, unknown>): Evaluate {
  const keys = Object.keys(scope);
  const values = keys.map((k) => scope[k]);
  return (src) => {
    const fn = compile(src, keys);
    if (!fn) return undefined;
    try {
      return fn(...values);
    } catch (error) {
      warnFailed(src, error);
      return undefined;
    }
  };
}

/**
 * Only the tests need to reach in: a compile cache that survived between
 * them would make one test's expression another's, and the warn-once flag
 * would hide the second failure anyone asserted on.
 */
export function clearExpressionCache(): void {
  CACHE.clear();
  warned = false;
}

// --- resolving a parsed document ------------------------------------------

/**
 * A copy of `nodes` with every `expression` replaced by the text it
 * evaluates to. Primitives stringify; anything else — an object, an array, a
 * React element — renders as nothing, because a paragraph is text and there
 * is nowhere in a text run to put an element (see "The inline half" in
 * docs/prd-mdx.md). `null` and `undefined` are nothing on purpose, so
 * `{maybe}` reads as absent rather than as the word "undefined".
 */
function resolveInline(nodes: InlineNode[], evaluate: Evaluate): InlineNode[] {
  let changed = false;
  const out: InlineNode[] = [];
  for (const node of nodes) {
    if (node.type === 'expression') {
      changed = true;
      const value = evaluate(node.src);
      const text =
        value == null ||
        typeof value === 'object' ||
        typeof value === 'function'
          ? ''
          : String(value);
      if (text) out.push({ type: 'text', text });
      continue;
    }
    if ('children' in node) {
      const children = resolveInline(node.children, evaluate);
      if (children !== node.children) {
        changed = true;
        out.push({ ...node, children });
        continue;
      }
    }
    out.push(node);
  }
  return changed ? out : nodes;
}

function resolveBlocks(blocks: BlockNode[], evaluate: Evaluate): BlockNode[] {
  let changed = false;
  const out = blocks.map((block): BlockNode => {
    switch (block.type) {
      case 'paragraph':
      case 'heading': {
        const children = resolveInline(block.children, evaluate);
        if (children === block.children) return block;
        changed = true;
        return { ...block, children };
      }
      case 'quote':
      case 'component': {
        const children = resolveBlocks(block.children, evaluate);
        if (children === block.children) return block;
        changed = true;
        return { ...block, children };
      }
      case 'list': {
        let itemsChanged = false;
        const items = block.items.map((item) => {
          const children = resolveBlocks(item.children, evaluate);
          if (children === item.children) return item;
          itemsChanged = true;
          return { ...item, children };
        });
        if (!itemsChanged) return block;
        changed = true;
        return { ...block, items };
      }
      case 'table': {
        let rowsChanged = false;
        const rows = block.rows.map((row) =>
          row.map((cell) => {
            const next = resolveInline(cell, evaluate);
            if (next !== cell) rowsChanged = true;
            return next;
          }),
        );
        const header = block.header.map((cell) => {
          const next = resolveInline(cell, evaluate);
          if (next !== cell) rowsChanged = true;
          return next;
        });
        if (!rowsChanged) return block;
        changed = true;
        return { ...block, header, rows };
      }
      default:
        return block;
    }
  });
  return changed ? out : blocks;
}

/**
 * The document with its expressions evaluated. `raws` is carried over
 * untouched: it is the block cache's key, and what changed is the values an
 * expression produced, not the text that produced them — a change of `scope`
 * invalidates that cache through its own identity instead.
 */
export function resolveExpressions(
  doc: Document,
  evaluate: Evaluate,
): Document {
  const blocks = resolveBlocks(doc.blocks, evaluate);
  return blocks === doc.blocks ? doc : { blocks, raws: doc.raws };
}
