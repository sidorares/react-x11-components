// <CodeEditor> — a multiline code editor: syntax highlighting through the
// pluggable language seam (built-in stream tokenizers, or Lezer / TextMate
// adapters), completion through async sources, LSP-shaped diagnostics.
//
// **Registration happens when this module is evaluated**, and that is the
// design, not a shortcut: nothing in the package registers anything until an
// app imports the component that needs it, so `sideEffects: false` stays
// honest and an app that never renders a code editor ships none of this. Do
// not move registration up into `../index.ts` — that is the one edit that
// would make the barrel pull every component into every bundle.
//
// The split of labour with `./node.ts`: the node owns the text model and the
// pixels; this file owns registration, the React component that wires input
// props to the node's `handle*` methods (user handlers run first, exactly
// core's ordering), and the completion popup — which is plain composition
// over `<popup>`, so an app can ignore it and build its own from the same
// `CompletionSource`s.
import React, { useCallback, useRef, useState } from 'react';
import type { ReactElement, ReactNode, Ref, RefObject } from 'react';
import { registerElement, registeredElements } from 'react-x11/host';
import { useTheme } from 'react-x11';
import type {
  DrawnNode,
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  WheelEvent,
} from 'react-x11';
import type { Style } from 'react-x11/style';
import {
  XK_BACKSPACE,
  XK_DOWN,
  XK_ESCAPE,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_RETURN,
  XK_SPACE,
  XK_TAB,
  XK_UP,
} from 'react-x11/keysyms';

// Loads the module the JSX augmentation at the bottom targets — nothing in
// `src/` writes JSX, so the build has no other reason to resolve it.
import type {} from 'react-x11/jsx-runtime';

import { hx } from './hx.js';
import { microtask } from '../code-language/timers.js';
import { CodeEditorNode, ELEMENT } from './node.js';
import type {
  CodeEditorEvent,
  CodeEditorHandle,
  CodeEditorProps,
} from './node.js';
import { rankCompletions } from './completion.js';
import type {
  CompletionContext,
  CompletionItem,
  CompletionResult,
  CompletionSource,
  Position,
} from '../code-language/types.js';
import { wordRangeAt } from './doc.js';

export { ELEMENT as CODE_EDITOR_ELEMENT };
export { CodeEditorNode };
export type { CodeEditorEvent, CodeEditorHandle, CodeEditorProps };

if (!registeredElements().includes(ELEMENT)) {
  registerElement(ELEMENT, {
    create: (props, app) => new CodeEditorNode(props, app),
    // none of the editor's prop names collide with the style vocabulary
    // today; `rows` and the colour props are its own the way they are
    // `<textinput>`'s. Declared anyway for the two an audit flagged as
    // near-misses, so a future style vocabulary addition fails loudly here
    // rather than silently in an app.
    semanticNames: ['rows', 'tabSize'],
    childrenAllowed: false,
  });
}

const MAX_VISIBLE_COMPLETIONS = 8;
const MAX_COMPLETIONS = 100;
/** A word character for the "should typing reopen the popup" test. */
const TRIGGER_CHAR = /[\p{L}\p{N}_.$]/u;
/** What the list may shrink to, and grow to, around its labels. Bounds
 * rather than a width: the popup measures its own rows (see below). */
const MIN_COMPLETION_WIDTH = 180;
const MAX_COMPLETION_WIDTH = 480;

interface CompletionState {
  items: CompletionItem[];
  /** Replacement start, per item source (parallel to items). */
  froms: (Position | undefined)[];
  from: Position; // the default (word start)
  selected: number;
  /** First visible row — the popup shows a window of the list. */
  offset: number;
  /** The caret, in the **editor's own coordinates** — the popup's `at`. */
  at: { x: number; y: number; width: number; height: number };
  rowHeight: number;
}

/** What `<CodeEditor completionSources>` takes — re-exported seam types. */
export type {
  CompletionContext,
  CompletionItem,
  CompletionResult,
  CompletionSource,
};

export interface CodeEditorComponentProps extends CodeEditorProps {
  /** Completion providers. Absent → completion is off entirely. */
  completionSources?: readonly CompletionSource[];
  /** Query sources while typing (default true when sources are given);
   * Ctrl+Space always works. */
  autoComplete?: boolean;
  focusable?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  /** The editor's imperative surface: `ref.current.value`, `.undo()`,
   * `.replaceRange(…)`, `.focus()` — see {@link CodeEditorHandle}. */
  ref?: Ref<CodeEditorHandle | null>;
  onKeyDown?: (ev: KeyboardEvent) => void;
  onMouseDown?: (ev: MouseEvent) => void;
  onFocus?: (ev: FocusEvent) => void;
  onBlur?: (ev: FocusEvent) => void;
}

const editorDefaults: Style = {
  fontFamily: 'monospace',
  fontSize: 13,
  padding: 8,
  borderWidth: 1,
  cursor: 'text',
  // theme tokens, so an unstyled editor is legible on a light *and* a dark
  // desktop: the node also picks its token palette from the resolved
  // background (see `_tokenStyles`), and the caret follows `color`
  color: '$text',
  backgroundColor: '$background',
  borderColor: '$border',
};

/**
 * ```tsx
 * <CodeEditor
 *   language={sql()}
 *   value={query}
 *   onChange={(ev) => setQuery(ev.value)}
 *   completionSources={[keywordCompletionSource(), sqlCompletionSource(schema)]}
 *   lineNumbers
 *   style={{ flexGrow: 1 }}
 * />
 * ```
 */
export function CodeEditor(props: CodeEditorComponentProps): ReactElement {
  const {
    completionSources,
    autoComplete = true,
    focusable = true,
    autoFocus,
    disabled,
    ref,
    onKeyDown: userKeyDown,
    onMouseDown: userMouseDown,
    onFocus: userFocus,
    onBlur: userBlur,
    style,
    ...nodeProps
  } = props;

  const theme = useTheme();
  const nodeRef = useRef<CodeEditorNode | null>(null);
  const [completion, setCompletion] = useState<CompletionState | null>(null);
  // bumped per query; a stale async result compares and drops itself
  const queryId = useRef(0);

  const setNode = useCallback(
    (n: unknown) => {
      nodeRef.current = n as CodeEditorNode | null;
      if (typeof ref === 'function') ref(nodeRef.current);
      else if (ref) ref.current = nodeRef.current;
    },
    [ref],
  );

  const close = useCallback(() => setCompletion(null), []);

  const query = useCallback(
    (trigger: 'input' | 'explicit') => {
      const node = nodeRef.current;
      if (!node || !completionSources || completionSources.length === 0) {
        return;
      }
      // a snapshot: the node's own array is live across edits, and an async
      // source must not see it move out from under the `pos` it was given
      const lines = node.lines.slice();
      const pos = node.selection.head;
      const wordChars = node.language?.data?.wordChars ?? '';
      const range = wordRangeAt(lines[pos.line], pos.ch, wordChars);
      const wordFrom = Math.min(range.from, pos.ch);
      const context: CompletionContext = {
        lines,
        pos,
        word: {
          from: { line: pos.line, ch: wordFrom },
          text: lines[pos.line].slice(wordFrom, pos.ch),
        },
        trigger,
        language: node.language,
      };
      const id = ++queryId.current;
      const stamp = `${node.value}\u0000${pos.line}:${pos.ch}`;
      Promise.all(
        completionSources.map((source) =>
          Promise.resolve()
            .then(() => source(context))
            .catch(() => null),
        ),
      ).then((results) => {
        const node2 = nodeRef.current;
        if (id !== queryId.current || !node2 || node2.destroyed) return;
        const pos2 = node2.selection.head;
        if (`${node2.value}\u0000${pos2.line}:${pos2.ch}` !== stamp) return;
        openPopup(node2, context, results);
      });
    },
    [completionSources],
  );

  const openPopup = (
    node: CodeEditorNode,
    context: CompletionContext,
    results: (CompletionResult | null)[],
  ): void => {
    const items: CompletionItem[] = [];
    const froms: (Position | undefined)[] = [];
    const seen = new Set<string>();
    for (const result of results) {
      if (!result) continue;
      const ranked = rankCompletions(result.items, context.word.text);
      for (const item of ranked) {
        const key = `${item.kind ?? ''}\u0000${item.label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
        froms.push(result.from);
        if (items.length >= MAX_COMPLETIONS) break;
      }
      if (items.length >= MAX_COMPLETIONS) break;
    }
    // re-rank across sources so a better match from a later source wins
    const order = rankCompletions(items, context.word.text);
    const orderedFroms = order.map((item) => froms[items.indexOf(item)]);
    if (order.length === 0) {
      setCompletion(null);
      return;
    }
    // Geometry stops here: the caret rect is all the popup needs, and it is
    // already in the editor's own coordinates, which is what `at` wants
    // (react-x11#280). Where that lands on screen, which side of the line
    // the list opens on, and how wide it is are all worked out by the popup
    // itself — see the `anchor` below for why they have to be.
    const caret = node.caretRect();
    const rowHeight = Math.ceil(node.metrics().lineHeight) + 6;
    setCompletion({
      items: order,
      froms: orderedFroms,
      from: context.word.from,
      selected: 0,
      offset: 0,
      at: { x: caret.x, y: caret.y, width: 1, height: caret.height },
      rowHeight,
    });
  };

  const accept = (state: CompletionState, index: number): void => {
    const node = nodeRef.current;
    if (!node) return;
    const item = state.items[index];
    if (!item) return;
    const from = state.froms[index] ?? state.from;
    node.replaceRange(from, node.selection.head, item.apply ?? item.label);
    setCompletion(null);
  };

  const moveSelection = (state: CompletionState, delta: number): void => {
    const count = state.items.length;
    const selected = Math.max(0, Math.min(count - 1, state.selected + delta));
    let offset = state.offset;
    if (selected < offset) offset = selected;
    if (selected >= offset + MAX_VISIBLE_COMPLETIONS) {
      offset = selected - MAX_VISIBLE_COMPLETIONS + 1;
    }
    setCompletion({ ...state, selected, offset });
  };

  // The completion popup's own keys, as an ordinary user-level handler: it
  // runs before the element's default action (react-x11#266), so consuming a
  // key here is exactly what stops the editor from also acting on it. The
  // editing keys, and the Escape-arms-one-Tab bargain that keeps the editor
  // from being a keyboard trap, belong to the node and are not repeated.
  const handleKeyDown = (ev: KeyboardEvent): void => {
    userKeyDown?.(ev);
    if (ev.defaultPrevented) return;
    const node = nodeRef.current;
    if (!node || disabled) return;
    const k = ev.keysym;

    if (completion) {
      if (k === XK_DOWN || k === XK_UP) {
        moveSelection(completion, k === XK_DOWN ? 1 : -1);
        ev.preventDefault();
        return;
      }
      if (k === XK_PAGE_DOWN || k === XK_PAGE_UP) {
        moveSelection(
          completion,
          (k === XK_PAGE_DOWN ? 1 : -1) * MAX_VISIBLE_COMPLETIONS,
        );
        ev.preventDefault();
        return;
      }
      if (k === XK_RETURN || (k === XK_TAB && !ev.shiftKey)) {
        accept(completion, completion.selected);
        ev.preventDefault();
        return;
      }
      if (k === XK_ESCAPE) {
        close();
        ev.preventDefault();
        return;
      }
    }

    // Ctrl+Space: explicit completion
    if (
      ev.ctrlKey &&
      (k === XK_SPACE || ev.codepoint === 0x20) &&
      completionSources?.length
    ) {
      query('explicit');
      ev.preventDefault();
      return;
    }

    // Escape with no popup open is the node's (it arms the Tab-out), and a
    // Tab it lets through is leaving the editor: either way the popup that
    // is not open needs nothing, but a stale one must not outlive the move.
    if (k === XK_ESCAPE || k === XK_TAB) close();

    // After the edit the node is about to make: retrigger or dismiss. In a
    // microtask because the default action has not run yet — the text this
    // reads is the text the key is about to produce.
    if (!completionSources || completionSources.length === 0) return;
    const typed =
      ev.codepoint != null && ev.codepoint >= 0x20 && !ev.ctrlKey
        ? String.fromCodePoint(ev.codepoint)
        : null;
    const editKey = typed !== null || k === XK_BACKSPACE;
    if (completion) {
      if (editKey) microtask(() => query('input'));
      else close();
    } else if (
      autoComplete &&
      typed !== null &&
      TRIGGER_CHAR.test(typed) &&
      !node.props.readOnly
    ) {
      microtask(() => query('input'));
    }
  };

  const handleMouseDown = (ev: MouseEvent): void => {
    userMouseDown?.(ev);
    if (ev.defaultPrevented) return;
    close();
  };

  const rows: ReactNode[] = [];
  if (completion) {
    const m = nodeRef.current?.metrics();
    const visible = completion.items.slice(
      completion.offset,
      completion.offset + MAX_VISIBLE_COMPLETIONS,
    );
    visible.forEach((item, i) => {
      const index = completion.offset + i;
      const selected = index === completion.selected;
      rows.push(
        hx(
          'box',
          {
            key: `${item.kind ?? ''}:${item.label}`,
            style: {
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingLeft: 8,
              paddingRight: 8,
              height: completion.rowHeight,
              backgroundColor: selected ? theme.accent : 'transparent',
            },
            onMouseDown: (rowEv: MouseEvent) => {
              rowEv.preventDefault();
              accept(completion, index);
            },
          },
          hx(
            'text',
            {
              style: {
                fontFamily: m?.family ?? 'monospace',
                fontSize: m?.size ?? 13,
                color: selected ? theme.accentText : theme.text,
                flexGrow: 1,
              },
            },
            item.label,
          ),
          item.detail
            ? hx(
                'text',
                {
                  style: {
                    fontSize: Math.max(10, (m?.size ?? 13) - 2),
                    color: selected ? theme.accentText : theme.dim,
                  },
                },
                item.detail,
              )
            : null,
        ),
      );
    });
  }

  // The editor element itself, plus (while open) the completion popup. A
  // fragment rather than a wrapper box: a `<popup>` is its own X window and
  // never participates in the parent's layout, so the app's style lands
  // directly on the editor node with no extra layout node in between.
  // No `theme` prop on the element: the node must inherit the nearest
  // node-level theme (a `<window theme>` above it), and stamping the React
  // context's palette here would override that with the default scheme —
  // the editors-render-light-on-a-dark-window bug. The popup below is a
  // separate X window that inherits nothing, so it does take the context
  // theme, same as the calendar's popups.
  const editor = React.createElement(ELEMENT, {
    ...(nodeProps as Record<string, unknown>),
    ref: setNode,
    // `focusableByDefault` on the node already makes a bare <codeeditor> a
    // tab stop; this is the app's override, and what keeps a disabled
    // editor out of the tab order entirely.
    focusable: focusable && !disabled,
    disabled,
    autoFocus,
    role: 'textbox',
    onKeyDown: handleKeyDown,
    onMouseDown: handleMouseDown,
    // Caret placement, drag-selection, focus and the caret blink are the
    // node's default actions now. Wheel has no default-action hook, so it
    // stays wired here.
    onWheel: (ev: WheelEvent) => {
      if (disabled) return;
      if (nodeRef.current?.handleWheel(ev)) ev.preventDefault();
    },
    onFocus: userFocus,
    onBlur: (ev: FocusEvent) => {
      close();
      userBlur?.(ev);
    },
    style: [editorDefaults, style as Style],
  });

  const popup =
    completion &&
    hx(
      'popup',
      {
        theme,
        // The popup places itself (react-x11#280), and it is the only thing
        // that can: with no `width`/`height` it is sized by the rows it
        // happens to be showing, and that size is settled after the content
        // is measured and before the window exists — past the last commit
        // that could have handed a rect in. Which side of the caret line the
        // list opens on is a function of that size, so it is core's answer
        // too, and it is taken against the usable part of the monitor rather
        // than the guess at the owner window this made before.
        //
        // `at` is the caret **inside** the editor, so the list opens on the
        // line being typed rather than under the editor, and follows it
        // through everything that can move it: the editor's own layout, an
        // ancestor scrolling, the window being dragged. When the caret
        // scrolls out of the editor the popup unmaps until it is back — a
        // list floating over text it no longer points into has no position
        // worth having.
        anchor: {
          to: nodeRef as unknown as RefObject<DrawnNode | null>,
          at: completion.at,
          placement: 'bottom',
        },
        // The bounds the label measuring used to enforce by hand.
        minWidth: MIN_COMPLETION_WIDTH,
        maxWidth: MAX_COMPLETION_WIDTH,
        // the grab is what dismisses on an outside press, menu-style; the
        // popup never takes focus, so typing continues in the editor
        grab: true,
        onDismiss: close,
      },
      hx(
        'box',
        {
          style: {
            flexGrow: 1,
            flexDirection: 'column',
            borderWidth: 1,
            borderColor: theme.border,
            backgroundColor: theme.background,
          },
        },
        ...rows,
      ),
    );

  return React.createElement(React.Fragment, null, editor, popup);
}

/**
 * What the raw `<codeeditor>` element takes: the node's props plus the
 * interaction surface the component normally wires for you. A named
 * interface rather than an inline type in the augmentation below, because
 * the augmentation exists twice in a checkout that compiles both `src/` and
 * `dist/` (the packaging test imports the built package by name), and two
 * property declarations only merge when they reference the same-shaped
 * named type.
 */
export interface CodeEditorElementProps extends CodeEditorProps {
  focusable?: boolean;
  autoFocus?: boolean;
  role?: string;
  ref?: Ref<unknown>;
  onKeyDown?: (ev: KeyboardEvent) => void;
  onMouseDown?: (ev: MouseEvent) => void;
  onMouseMove?: (ev: MouseEvent) => void;
  onMouseUp?: (ev: MouseEvent) => void;
  onWheel?: (ev: WheelEvent) => void;
  onFocus?: (ev: FocusEvent) => void;
  onBlur?: (ev: FocusEvent) => void;
}

// Importing this module teaches JSX the raw element too.
declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      codeeditor: CodeEditorElementProps;
    }
  }
}

// The language + completion surface, re-exported so one import serves the
// whole feature. Each language module is pure until called, so a bundler
// keeps only what an app touches.
export {
  lineModeLanguage,
  streamLanguage,
  StringStream,
} from '../code-language/stream.js';
export type { LineMode, StreamMode } from '../code-language/stream.js';
export { sql } from '../code-language/languages/sql.js';
export type { SqlOptions } from '../code-language/languages/sql.js';
export { shell } from '../code-language/languages/shell.js';
export { glsl } from '../code-language/languages/glsl.js';
export { javascript } from '../code-language/languages/javascript.js';
export type { JavascriptOptions } from '../code-language/languages/javascript.js';
export { json } from '../code-language/languages/json.js';
export {
  keywordCompletionSource,
  rankCompletions,
  sqlCompletionSource,
  wordCompletionSource,
} from './completion.js';
export type { SqlSchema } from './completion.js';
export {
  autoTokenStyles,
  DARK_TOKEN_STYLES,
  isDarkBackground,
  LIGHT_TOKEN_STYLES,
  tokenStyleFor,
} from '../code-language/theme.js';
export { lezerLanguage } from '../code-language/lezer.js';
export type {
  LezerHighlightLike,
  LezerLanguageOptions,
  LezerParserLike,
} from '../code-language/lezer.js';
export { textMateLanguage } from '../code-language/textmate.js';
export type {
  TextMateGrammarLike,
  TextMateLanguageOptions,
  TextMateStateLike,
} from '../code-language/textmate.js';
export type {
  Diagnostic,
  Language,
  LanguageData,
  LineEdit,
  Position,
  Selection,
  Token,
  Tokenizer,
  TokenizerHost,
  TokenStyle,
  TokenStyles,
  TokenType,
} from '../code-language/types.js';
export { TOKEN_FALLBACK } from '../code-language/types.js';
