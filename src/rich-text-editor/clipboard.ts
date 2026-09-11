// Copy and paste, in the formats every other application speaks.
//
// A copy offers three things: `text/html` (the schema's `toDOM`, with
// ProseMirror's `data-pm-slice` marker so the open sides survive), plain text
// (the `clipboardTextSerializer` prop, or blocks a blank line apart — the
// markdown editor's default hands markdown here), and, in this process only,
// the slice itself. The last is not an optimisation: react-x11's Cocoa
// clipboard carries one flavour, text (react-x11 docs/clipboard.md,
// "Limits"), so without it a copy and paste inside one editor would flatten
// every heading and list on a Mac. A paste whose text is exactly what this
// process last put there takes the slice back instead of re-reading it.
//
// Reading is prosemirror-view's `parseFromClipboard`, ported: the same
// props, in the same order, over the DOM shim in `./html.ts` instead of a
// browser's — so a paste from a web page is read by the schema's own
// `parseDOM` rules, and a plugin's `transformPasted` sees what it would see
// in a browser. The helpers below `parseFromClipboard` are prosemirror-view's
// own (MIT), which does not export them; they are pure functions over the
// model and came across unchanged.
import { DOMParser, DOMSerializer, Fragment, Slice } from 'prosemirror-model';
import type {
  Node as PMNode,
  NodeType,
  ParseOptions,
  ResolvedPos,
} from 'prosemirror-model';
import type { EditorProps, EditorView } from 'prosemirror-view';

import { clipboardHTML, readHTML, sliceFromElement } from './html.js';
import type { ShimElement } from './html.js';
import type { EditorState } from 'prosemirror-state';

/** What the clipboard code needs of the view — `someProp` over the props a
 *  plugin can supply, and the state. */
export interface ClipboardView {
  readonly state: EditorState;
  someProp<K extends keyof EditorProps, R>(
    name: K,
    f: (value: NonNullable<EditorProps[K]>) => R,
  ): R | undefined;
  /** The view as a plugin's callback is handed it. */
  readonly asEditorView: EditorView;
}

/** What a copy puts on the clipboard. */
export interface ClipboardContent {
  html: string;
  text: string;
  slice: Slice;
}

export function serializeForClipboard(
  view: ClipboardView,
  slice: Slice,
): ClipboardContent {
  view.someProp('transformCopied', (f) => {
    slice = f(slice, view.asEditorView);
  });
  const context: unknown[] = [];
  let { content, openStart, openEnd } = slice;
  while (
    openStart > 1 &&
    openEnd > 1 &&
    content.childCount === 1 &&
    content.firstChild!.childCount === 1
  ) {
    openStart--;
    openEnd--;
    const node = content.firstChild!;
    // a node made with no attributes shares its type's default object —
    // ProseMirror's own test, through a member its declarations leave out
    const defaults = (node.type as unknown as { defaultAttrs?: unknown })
      .defaultAttrs;
    context.push(node.type.name, node.attrs !== defaults ? node.attrs : null);
    content = node.content;
  }
  const serializer =
    view.someProp('clipboardSerializer', (s) => s) ??
    DOMSerializer.fromSchema(view.state.schema);
  const html = clipboardHTML(serializer, content, openStart, openEnd, context);
  const text =
    view.someProp('clipboardTextSerializer', (f) =>
      f(slice, view.asEditorView),
    ) || slice.content.textBetween(0, slice.content.size, '\n\n');
  return { html, text, slice };
}

const INLINE_PARENTS =
  /^(a|abbr|acronym|b|cite|code|del|em|i|ins|kbd|label|output|q|ruby|s|samp|span|strong|sub|sup|time|u|tt|var)$/i;

/** A paste — or a drop — read into a slice. `plainText` is a paste that
 *  asked for no formatting (Shift held). */
export function parseFromClipboard(
  view: ClipboardView,
  text: string | null,
  html: string | null,
  plainText: boolean,
  $context: ResolvedPos,
): Slice | null {
  const { schema } = view.state;
  const inCode = !!$context.parent.type.spec.code;
  let dom: ShimElement | null = null;
  let slice: Slice | null = null;
  if (!html && !text) return null;
  const asText = !!text && (plainText || inCode || !html);
  if (asText) {
    let pasted = text!;
    view.someProp('transformPastedText', (f) => {
      pasted = f(pasted, inCode || plainText, view.asEditorView);
    });
    if (inCode) {
      let codeSlice = pasted
        ? new Slice(
            Fragment.from(schema.text(pasted.replace(/\r\n?/g, '\n'))),
            0,
            0,
          )
        : Slice.empty;
      view.someProp('transformPasted', (f) => {
        codeSlice = f(codeSlice, view.asEditorView, true);
      });
      return codeSlice;
    }
    const parsed = view.someProp('clipboardTextParser', (f) =>
      f(pasted, $context, plainText, view.asEditorView),
    );
    if (parsed) {
      slice = parsed;
    } else {
      // One paragraph per line, carrying the marks at the caret — what
      // ProseMirror builds as `<p>`s and parses, built directly.
      const marks = $context.marks();
      const paragraph = defaultTextblock($context);
      if (paragraph) {
        const blocks = pasted
          .split(/(?:\r\n?|\n)+/)
          .map((line) =>
            paragraph.create(null, line ? schema.text(line, marks) : null),
          );
        slice = Slice.maxOpen(Fragment.from(blocks));
      } else {
        slice = new Slice(Fragment.from(schema.text(pasted, marks)), 0, 0);
      }
    }
  } else {
    let source = html!;
    view.someProp('transformPastedHTML', (f) => {
      source = f(source, view.asEditorView);
    });
    dom = readHTML(source);
  }

  const contextNode = dom
    ? dom.matches('[data-pm-slice]')
      ? dom
      : dom.querySelector('[data-pm-slice]')
    : null;
  const sliceData =
    contextNode &&
    /^(\d+) (\d+)(?: -(\d+))? (.*)/.exec(
      contextNode.getAttribute('data-pm-slice') || '',
    );
  if (dom && sliceData && sliceData[3]) {
    for (let i = +sliceData[3]; i > 0; i--) {
      let child = dom.firstChild;
      while (child && child.nodeType !== 1) child = child.nextSibling;
      if (!child) break;
      dom = child as ShimElement;
    }
  }

  if (!slice && dom) {
    const parser =
      view.someProp('clipboardParser', (p) => p) ??
      view.someProp('domParser', (p) => p) ??
      DOMParser.fromSchema(schema);
    // `ruleFromNode` is a parse option prosemirror-view passes and
    // prosemirror-model's declarations leave out: a trailing `<br>` in a
    // block is the browser's placeholder, not a line break
    const options = {
      preserveWhitespace: !!(asText || sliceData),
      context: $context,
      ruleFromNode(node: unknown) {
        const el = node as ShimElement;
        if (
          el.nodeName === 'BR' &&
          !el.nextSibling &&
          el.parentNode &&
          !INLINE_PARENTS.test(el.parentNode.nodeName)
        ) {
          return { ignore: true };
        }
        return null;
      },
    };
    slice = sliceFromElement(parser, dom, options as ParseOptions);
  }
  if (!slice) return null;

  if (sliceData) {
    slice = addContext(
      closeSlice(slice, +sliceData[1], +sliceData[2]),
      sliceData[4],
    );
  } else {
    // HTML that did not come from ProseMirror: make the top-level siblings
    // coherent, so `replace` can place them at all
    slice = Slice.maxOpen(normalizeSiblings(slice.content, $context), true);
    if (slice.openStart || slice.openEnd) {
      let openStart = 0;
      let openEnd = 0;
      for (
        let node = slice.content.firstChild;
        openStart < slice.openStart && node && !node.type.spec.isolating;
        openStart++, node = node.firstChild
      ) {
        // counting
      }
      for (
        let node = slice.content.lastChild;
        openEnd < slice.openEnd && node && !node.type.spec.isolating;
        openEnd++, node = node.lastChild
      ) {
        // counting
      }
      slice = closeSlice(slice, openStart, openEnd);
    }
  }
  const result = slice;
  let transformed = result;
  view.someProp('transformPasted', (f) => {
    transformed = f(transformed, view.asEditorView, asText);
  });
  return transformed;
}

/** The textblock a line of pasted text becomes: the first one the context
 *  can hold, which in every schema anyone writes is the paragraph. */
function defaultTextblock($context: ResolvedPos): NodeType | null {
  for (let d = $context.depth; d >= 0; d--) {
    const type = $context.node(d).contentMatchAt($context.index(d)).defaultType;
    if (type?.isTextblock) return type;
  }
  return null;
}

// --- prosemirror-view's helpers (MIT, Marijn Haverbeke) ----------------------

// Takes a slice parsed with parseSlice, which means there hasn't been any
// content-expression checking done on the top nodes, tries to find a parent
// node in the current context that might fit the nodes, and if successful,
// rebuilds the slice so that it fits into that parent.
function normalizeSiblings(
  fragment: Fragment,
  $context: ResolvedPos,
): Fragment {
  if (fragment.childCount < 2) return fragment;
  for (let d = $context.depth; d >= 0; d--) {
    const parent = $context.node(d);
    let match = parent.contentMatchAt($context.index(d));
    let lastWrap: readonly NodeType[] = [];
    let result: PMNode[] | null = [];
    fragment.forEach((node) => {
      if (!result) return;
      const wrap = match.findWrapping(node.type);
      if (!wrap) {
        result = null;
        return;
      }
      const inLast =
        result.length &&
        lastWrap.length &&
        addToSibling(wrap, lastWrap, node, result[result.length - 1], 0);
      if (inLast) {
        result[result.length - 1] = inLast;
      } else {
        if (result.length) {
          result[result.length - 1] = closeRight(
            result[result.length - 1],
            lastWrap.length,
          );
        }
        const wrapped = withWrappers(node, wrap);
        result.push(wrapped);
        match = match.matchType(wrapped.type)!;
        lastWrap = wrap;
      }
    });
    if (result) return Fragment.from(result);
  }
  return fragment;
}

function withWrappers(
  node: PMNode,
  wrap: readonly NodeType[],
  from = 0,
): PMNode {
  for (let i = wrap.length - 1; i >= from; i--) {
    node = wrap[i].create(null, Fragment.from(node));
  }
  return node;
}

function addToSibling(
  wrap: readonly NodeType[],
  lastWrap: readonly NodeType[],
  node: PMNode,
  sibling: PMNode,
  depth: number,
): PMNode | undefined {
  if (
    depth < wrap.length &&
    depth < lastWrap.length &&
    wrap[depth] === lastWrap[depth]
  ) {
    const inner = addToSibling(
      wrap,
      lastWrap,
      node,
      sibling.lastChild!,
      depth + 1,
    );
    if (inner) {
      return sibling.copy(
        sibling.content.replaceChild(sibling.childCount - 1, inner),
      );
    }
    const match = sibling.contentMatchAt(sibling.childCount);
    if (
      match.matchType(depth === wrap.length - 1 ? node.type : wrap[depth + 1])
    ) {
      return sibling.copy(
        sibling.content.append(
          Fragment.from(withWrappers(node, wrap, depth + 1)),
        ),
      );
    }
  }
  return undefined;
}

function closeRight(node: PMNode, depth: number): PMNode {
  if (depth === 0) return node;
  const fragment = node.content.replaceChild(
    node.childCount - 1,
    closeRight(node.lastChild!, depth - 1),
  );
  const fill = node
    .contentMatchAt(node.childCount)
    .fillBefore(Fragment.empty, true)!;
  return node.copy(fragment.append(fill));
}

function closeRange(
  fragment: Fragment,
  side: number,
  from: number,
  to: number,
  depth: number,
  openEnd: number,
): Fragment {
  const node = side < 0 ? fragment.firstChild! : fragment.lastChild!;
  let inner = node.content;
  if (fragment.childCount > 1) openEnd = 0;
  if (depth < to - 1)
    inner = closeRange(inner, side, from, to, depth + 1, openEnd);
  if (depth >= from) {
    inner =
      side < 0
        ? node
            .contentMatchAt(0)
            .fillBefore(inner, openEnd <= depth)!
            .append(inner)
        : inner.append(
            node
              .contentMatchAt(node.childCount)
              .fillBefore(Fragment.empty, true)!,
          );
  }
  return fragment.replaceChild(
    side < 0 ? 0 : fragment.childCount - 1,
    node.copy(inner),
  );
}

function closeSlice(slice: Slice, openStart: number, openEnd: number): Slice {
  if (openStart < slice.openStart) {
    slice = new Slice(
      closeRange(
        slice.content,
        -1,
        openStart,
        slice.openStart,
        0,
        slice.openEnd,
      ),
      openStart,
      slice.openEnd,
    );
  }
  if (openEnd < slice.openEnd) {
    slice = new Slice(
      closeRange(slice.content, 1, openEnd, slice.openEnd, 0, 0),
      slice.openStart,
      openEnd,
    );
  }
  return slice;
}

function addContext(slice: Slice, context: string): Slice {
  if (!slice.size) return slice;
  const schema = slice.content.firstChild!.type.schema;
  let array: unknown[];
  try {
    array = JSON.parse(context) as unknown[];
  } catch {
    return slice;
  }
  let { content, openStart, openEnd } = slice;
  for (let i = array.length - 2; i >= 0; i -= 2) {
    const type = schema.nodes[array[i] as string];
    if (!type || type.hasRequiredAttrs()) break;
    try {
      (type as unknown as { checkAttrs(attrs: unknown): void }).checkAttrs(
        array[i + 1],
      );
    } catch {
      break;
    }
    content = Fragment.from(
      type.create(array[i + 1] as Record<string, unknown>, content),
    );
    openStart++;
    openEnd++;
  }
  return new Slice(content, openStart, openEnd);
}
