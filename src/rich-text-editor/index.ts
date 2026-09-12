// <RichTextEditor> — a WYSIWYG editor: ProseMirror's document model and
// plugin system, drawn and driven by react-x11.
//
// The ladder, one element all the way up (docs/prd-rich-text-editor.md):
//
//   1. `defaultValue` / `value` + `onChange` — markdown in and out, and a
//      caller never meets ProseMirror;
//   2. `toolbar`, `placeholder`, `readOnly`, `onSubmit`, `suggestions` — the
//      chrome and the behaviours an app would otherwise wire by hand;
//   3. `format="html" | "text"`, `markStyles`, `renderImage`, `nodeViews` —
//      what the document is written in, and how its parts look;
//   4. `plugins`, `editorProps`, `schema` — ProseMirror's own seams, so the
//      ecosystem's plugins and schemas plug in as they are;
//   5. `state` + `dispatchTransaction` — the app owns the EditorState outright.
//
// **Registration happens when this module is evaluated** — the editor's two
// elements, and `<richtext>` for the toolbar's labels — which is the one side
// effect the package's tree-shaking contract allows (AGENTS.md).
//
// **Not in the barrel.** `src/index.ts` re-exports every other component;
// this one is imported from `@react-x11/components/rich-text-editor`.
// ProseMirror's declarations name DOM globals (`dom-globals.d.ts` has the
// four this repository supplies for itself), and an app importing *anything*
// from the barrel loads every re-exported module's declarations — so every
// app would inherit that requirement to use a calendar. The subpath keeps it
// with the apps that use the editor.
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ComponentType, ReactElement, ReactNode, Ref } from 'react';
import { useApp, useClipboard, useTheme } from 'react-x11';
import type {
  DrawnNode,
  FocusEvent,
  KeyboardEvent,
  MouseEvent as X11MouseEvent,
  ScrollableNode,
} from 'react-x11';
import { XK_ESCAPE, XK_KP_ENTER, XK_RETURN } from 'react-x11/keysyms';
import { tint } from 'react-x11/style';
import type { Style } from 'react-x11/style';
import { toggleMark } from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import { Fragment, Slice } from 'prosemirror-model';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { EditorState, Selection } from 'prosemirror-state';
import type { Command, Plugin, Transaction } from 'prosemirror-state';
import type { EditorProps, EditorView } from 'prosemirror-view';

// Loads the module the JSX augmentation at the bottom targets — nothing in
// `src/` writes JSX, so the build has no other reason to resolve it.
import type {} from 'react-x11/jsx-runtime';

import { hx } from '../internal/hx.js';
import { registerRichText } from '../richtext/index.js';
import type { TextRun } from '../richtext/index.js';
import type { Language } from '../code-language/index.js';
import {
  isBlockActive,
  isMarkActive,
  markAttrs,
  setLink,
  toggleBlockType,
  toggleList,
  toggleWrap,
} from './commands.js';
import { docFromHTML, htmlFromContent } from './html.js';
import { defaultPlugins } from './keymap.js';
import { deriveLook } from './look.js';
import type { MarkStyle } from './look.js';
import { docFromText, markdownCodec, textFromDoc } from './markdown.js';
import type { MarkdownCodec } from './markdown.js';
import { registerEditorElements, ROOT_ELEMENT, TEXT_ELEMENT } from './nodes.js';
import { renderBlocks } from './render.js';
import type { ImageInfo, NodeViewProps, RenderContext } from './render.js';
import type { RunStyle } from './inline.js';
import { schema as defaultSchema } from './schema.js';
import {
  acceptSuggestion,
  SUGGESTION_PAGE,
  suggesterFor,
  suggestionState,
  suggestions as suggestionPlugin,
} from './suggest.js';
import type { Suggester } from './suggest.js';
import {
  DEFAULT_TOOLBAR,
  resolveToolbar,
  Toolbar,
  toolbarItems,
} from './toolbar.js';
import type { ToolbarEntry } from './toolbar.js';
import { RichEditorView } from './view.js';
import type { ViewConfig, ViewProps } from './view.js';

registerRichText();
registerEditorElements();

const h = React.createElement;

// --- props -------------------------------------------------------------------

/** What `value`, `defaultValue` and `ev.value` are written in. */
export type EditorFormat = 'markdown' | 'html' | 'text';

/** What `onChange` hears. `value` is serialized when it is first read, so a
 *  listener that only wants to know *that* something changed pays nothing. */
export interface RichTextEditorChangeEvent {
  type: 'change';
  /** The document, in `format`. */
  readonly value: string;
  readonly doc: PMNode;
  readonly state: EditorState;
  readonly transactions: readonly Transaction[];
  readonly name: string | undefined;
  readonly target: RichTextEditorHandle;
}

/** What `onSubmit` and `onSelectionChange` hear. */
export interface RichTextEditorEvent {
  type: 'submit' | 'selectionchange';
  readonly value: string;
  readonly state: EditorState;
  readonly name: string | undefined;
  readonly target: RichTextEditorHandle;
}

/** The editor's imperative surface — the component's `ref`. */
export interface RichTextEditorHandle {
  /** The EditorView-shaped view: `dispatch`, `state`, `someProp`,
   *  `posAtCoords`… — what a ProseMirror plugin or command is handed. */
  readonly view: RichEditorView;
  readonly state: EditorState;
  readonly schema: Schema;
  /** The document in `format` — the editor's own, when not given. */
  getValue(format?: EditorFormat): string;
  /** Replace the document. Not undoable, the way a form reset is not,
   *  unless `addToHistory` says so. */
  setValue(
    value: string | PMNode,
    options?: { format?: EditorFormat; addToHistory?: boolean },
  ): void;
  /** Insert content where the selection is — markdown, HTML, text or a node. */
  insertContent(value: string | PMNode, format?: EditorFormat): void;
  /** Run a ProseMirror command against the current state. */
  run(command: Command): boolean;
  /** Could `command` run now? — the question a toolbar greys a button on. */
  can(command: Command): boolean;
  /** A mark (by name) on the selection, or a node (by name, with `attrs`)
   *  around it. */
  isActive(name: string, attrs?: Record<string, unknown>): boolean;
  toggleMark(name: string, attrs?: Record<string, unknown>): boolean;
  /** A textblock type — or back to a paragraph when it already is one. */
  setBlock(name: string, attrs?: Record<string, unknown>): boolean;
  toggleList(name: string): boolean;
  toggleWrap(name: string): boolean;
  undo(): boolean;
  redo(): boolean;
  /** Open the link editor on the selection — what Mod-K does. */
  editLink(): void;
  focus(): void;
  blur(): void;
}

/** A document the app hands over as a value, not as ProseMirror state. */
interface ValueProps {
  /** Uncontrolled initial document: a string in `format`, or a node. */
  defaultValue?: string | PMNode;
  /**
   * The document, as a string in `format`. A value different from the one
   * the editor last reported replaces the document — a reset, not undoable;
   * handing back what `onChange` reported changes nothing.
   */
  value?: string;
  state?: undefined;
  dispatchTransaction?: undefined;
}

/** The top rung: the app owns the ProseMirror state. */
interface StateProps {
  /** The whole EditorState — schema, plugins and all. The editor's default
   *  plugins are the app's to include: `defaultPlugins(schema)`. */
  state: EditorState;
  /** Called with every transaction; the app applies it and passes the new
   *  state back (ProseMirror's own contract). */
  dispatchTransaction: (tr: Transaction) => void;
  defaultValue?: never;
  value?: never;
}

interface CommonProps {
  /** What `value`/`defaultValue`/`ev.value` are written in. Default
   *  `'markdown'`. */
  format?: EditorFormat;
  onChange?: (ev: RichTextEditorChangeEvent) => void;
  onSelectionChange?: (ev: RichTextEditorEvent) => void;
  /** Mod-Enter — or plain Enter, with `submitOnEnter`. */
  onSubmit?: (ev: RichTextEditorEvent) => void;
  /** Enter submits (Shift+Enter is a new line) — a chat composer. Not in a
   *  list or a code block, where Enter goes on editing. */
  submitOnEnter?: boolean;
  /** A link was activated: Mod-click while editing, a click when read-only.
   *  The editor never navigates by itself. */
  onLink?: (href: string, ev: X11MouseEvent<DrawnNode>) => void;
  /** Lists that open at a trigger character as its word is typed — `@` for
   *  people, `#` for issues, `/` for a block menu. A new array on every
   *  render is fine: the plugin reads the latest one. */
  suggestions?: readonly Suggester[];
  placeholder?: string;
  /** Selectable and copyable, not editable. */
  readOnly?: boolean;
  /** Inert, out of the tab order, dimmed. */
  disabled?: boolean;
  autoFocus?: boolean;
  /** Echoed on every event. */
  name?: string;

  /** The formatting toolbar: `true` for the default set, an array to pick
   *  and order (built-in names, `'|'`, items of your own), or a function
   *  rendering your own, handed the editor. */
  toolbar?:
    | boolean
    | readonly ToolbarEntry[]
    | ((editor: RichTextEditorHandle) => ReactNode);

  /** Base text. Default: the theme's `fontSize`, and `sans-serif`. */
  fontSize?: number;
  fontFamily?: string;
  /** Code, inline and fenced. Default `'monospace'`. */
  monoFamily?: string;
  /** How a mark looks, by mark name — over, or instead of, the built-in
   *  look. A function is handed the mark and the style under it. */
  markStyles?: Readonly<Record<string, MarkStyle>>;
  /** How a decoration's `class` looks: the one part of a plugin's DOM
   *  decoration this editor cannot read off the decoration itself. */
  decorationClasses?: Readonly<Record<string, RunStyle>>;
  /** Syntax colouring in code blocks. Default true. */
  highlight?: boolean;
  /** A `Language` for a fence tag the built-in tokenizers do not cover —
   *  `<Markdown>`'s seam, for the same fences. */
  resolveLanguage?: (tag: string) => Language | null;
  /** An image alone in its paragraph, drawn. The editor fetches nothing:
   *  without this an image is its alt text. */
  renderImage?: (image: ImageInfo) => ReactNode;

  /** The document model. Default: GFM (`schema` from this module). */
  schema?: Schema;
  /** A markdown codec for a schema the built-in one cannot read or write. */
  markdown?: MarkdownCodec;
  /** ProseMirror plugins, ahead of the editor's own — so a keymap here wins
   *  over the defaults. Give the array a stable identity. */
  plugins?: readonly Plugin[];
  /** The defaults — each can be turned off: undo history, markdown input
   *  rules, formatting shortcuts, and (off by default) typographic quotes. */
  history?: boolean;
  inputRules?: boolean;
  keymap?: boolean;
  typography?: boolean;
  /** ProseMirror's view props — `handleKeyDown`, `handlePaste`,
   *  `decorations`, `transformPasted`… — without writing a plugin. */
  editorProps?: EditorProps<unknown>;
  /** Custom rendering by node type: a React component, handed the node, its
   *  rendered content and a way to update its attributes. */
  nodeViews?: Readonly<Record<string, ComponentType<NodeViewProps>>>;

  /** The frame: width, height, `flexGrow`, border, background. */
  style?: Style | Style[];
  /** The parts inside it. */
  styles?: { toolbar?: Style; content?: Style };
  ref?: Ref<RichTextEditorHandle | null>;
  onKeyDown?: (ev: KeyboardEvent) => void;
  onMouseDown?: (ev: X11MouseEvent) => void;
  onFocus?: (ev: FocusEvent) => void;
  onBlur?: (ev: FocusEvent) => void;
  'aria-label'?: string;
  'data-testname'?: string;
}

export type RichTextEditorProps = CommonProps & (ValueProps | StateProps);

// --- formats -----------------------------------------------------------------

interface Codec {
  parse(source: string): PMNode;
  serialize(doc: PMNode): string;
}

function codecFor(
  schema: Schema,
  format: EditorFormat,
  markdown?: MarkdownCodec,
): Codec {
  switch (format) {
    case 'html':
      return {
        parse: (source) => docFromHTML(schema, source),
        serialize: (doc) => htmlFromContent(schema, doc),
      };
    case 'text':
      return {
        parse: (source) => docFromText(schema, source),
        serialize: textFromDoc,
      };
    default:
      return markdown ?? markdownCodec(schema);
  }
}

function replaceDocument(
  view: RichEditorView,
  doc: PMNode,
  addToHistory: boolean,
): void {
  const { state } = view;
  const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content);
  // keep the caret about where it was, inside what is there now
  tr.setSelection(
    Selection.near(
      tr.doc.resolve(Math.min(state.selection.head, tr.doc.content.size)),
    ),
  );
  if (!addToHistory) tr.setMeta('addToHistory', false);
  view.dispatch(tr);
}

function inListOrCode(state: EditorState): boolean {
  const { $from } = state.selection;
  if ($from.parent.type.spec.code) return true;
  for (let d = $from.depth; d > 0; d--) {
    if (/item$/i.test($from.node(d).type.name)) return true;
  }
  return false;
}

function linkAt(state: EditorState, pos: number): string | null {
  const $pos = state.doc.resolve(pos);
  const node =
    $pos.parent.childAfter($pos.parentOffset).node ?? $pos.nodeBefore;
  const link = node?.marks.find((m) => m.type.name === 'link');
  return link && typeof link.attrs.href === 'string' ? link.attrs.href : null;
}

// --- the component -----------------------------------------------------------

interface LinkEdit {
  at: { x: number; y: number; width: number; height: number };
  draft: string;
}

/**
 * ```tsx
 * <RichTextEditor
 *   defaultValue={note.body}
 *   onChange={(ev) => save(ev.value)}
 *   placeholder="Write something…"
 *   toolbar
 *   style={{ flexGrow: 1 }}
 * />
 * ```
 */
export function RichTextEditor(props: RichTextEditorProps): ReactElement {
  const theme = useTheme() as unknown as Record<string, unknown>;
  const clipboard = useClipboard();
  const {
    placeholder,
    readOnly = false,
    disabled = false,
    autoFocus,
    toolbar,
    style,
    styles,
  } = props;
  const format = props.format ?? 'markdown';
  const schema = props.state?.schema ?? props.schema ?? defaultSchema;
  const codec = useMemo(
    () => codecFor(schema, format, props.markdown),
    [schema, format, props.markdown],
  );

  // The latest props, for the callbacks the view holds on to.
  const latest = useRef(props);
  latest.current = props;
  const codecRef = useRef(codec);
  codecRef.current = codec;

  const look = useMemo(
    () =>
      deriveLook(theme, {
        fontSize: props.fontSize,
        fontFamily: props.fontFamily,
        monoFamily: props.monoFamily,
        markStyles: props.markStyles,
        resolveLanguage: props.resolveLanguage,
        highlight: props.highlight,
        dim: disabled,
      }),
    [
      theme,
      props.fontSize,
      props.fontFamily,
      props.monoFamily,
      props.markStyles,
      props.resolveLanguage,
      props.highlight,
      disabled,
    ],
  );

  // The editor's own plugins, made once per schema and option set — a
  // plugin instance carries its state across a reconfigure, so the undo
  // history survives an app swapping its own plugins.
  const defaults = useMemo(
    () =>
      defaultPlugins(schema, {
        history: props.history,
        inputRules: props.inputRules,
        keymap: props.keymap,
        typography: props.typography,
      }),
    [schema, props.history, props.inputRules, props.keymap, props.typography],
  );
  // The suggestion plugin, made once while there are suggesters: it reads
  // the latest prop through `latest`, so an inline array is not a rebuild —
  // a rebuild would drop the list that is open.
  const suggesting = !!props.suggestions?.length;
  const suggest = useMemo(
    () =>
      suggesting
        ? suggestionPlugin(() => latest.current.suggestions ?? [])
        : null,
    [suggesting],
  );
  const plugins = useMemo(
    () => [
      ...(props.plugins ?? []),
      // ahead of the defaults, so a row takes Enter before the keymap does
      ...(suggest ? [suggest] : []),
      ...defaults,
    ],
    [props.plugins, suggest, defaults],
  );

  const listeners = useRef(new Set<() => void>());
  /** The value last reported through `onChange`, or accepted from `value`. */
  const reported = useRef<string | null>(null);
  const handleRef = useRef<RichTextEditorHandle | null>(null);
  const rootRef = useRef<DrawnNode | null>(null);
  const [linkEdit, setLinkEdit] = useState<LinkEdit | null>(null);
  // A suggestion list shows only while the editor has focus.
  const [focused, setFocused] = useState(false);

  // The trigger being typed is drawn in the accent colour, unless the app
  // says what the `suggestion` class looks like. Memoized: a new object
  // redraws every block's decorations (`configure`).
  const decorationClasses = useMemo(
    () => ({ suggestion: { color: look.accent }, ...props.decorationClasses }),
    [look.accent, props.decorationClasses],
  );

  const config: ViewConfig = {
    onRender: () => {},
    onUpdate: (prev, trs) => onUpdate(prev, trs),
    onFocusChange: setFocused,
    clipboard,
    ...(placeholder ? { placeholder } : null),
    colors: {
      selection: look.selection,
      selectionBlurred: look.selectionBlurred,
      caret: look.caret,
      placeholder: look.muted,
      preedit: look.text,
    },
    decorationClasses,
  };

  const viewRef = useRef<RichEditorView | null>(null);
  if (!viewRef.current) {
    let state = props.state;
    if (!state) {
      const initial = props.value ?? props.defaultValue;
      if (typeof initial === 'string') reported.current = initial;
      const doc =
        initial === undefined
          ? undefined
          : typeof initial === 'string'
            ? codec.parse(initial)
            : initial;
      state = EditorState.create({ schema, doc, plugins });
    }
    const viewProps: ViewProps = {
      ...props.editorProps,
      editable: () => !latest.current.readOnly && !latest.current.disabled,
      handleClick: (view, pos, event) => {
        const own = latest.current.editorProps?.handleClick;
        if (own?.call(undefined, view, pos, event)) return true;
        return openLinkAt(pos, event as unknown as X11MouseEvent<DrawnNode>);
      },
      ...(props.dispatchTransaction
        ? {
            dispatchTransaction: (tr: Transaction) =>
              latest.current.dispatchTransaction?.(tr),
          }
        : null),
    };
    viewRef.current = new RichEditorView(state, viewProps, config);
  }
  const view = viewRef.current;

  // Every state change re-renders this component; the document itself only
  // re-renders the blocks whose nodes changed (./render.ts).
  const subscribe = useCallback((fn: () => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);
  const state = useSyncExternalStore(
    subscribe,
    () => view.state,
    () => view.state,
  );

  function event(type: RichTextEditorEvent['type']): RichTextEditorEvent {
    const at = view.state;
    let cached: string | null = null;
    return {
      type,
      get value() {
        return (cached ??= codecRef.current.serialize(at.doc));
      },
      state: at,
      name: latest.current.name,
      target: handleRef.current!,
    };
  }

  function onUpdate(prev: EditorState, trs: readonly Transaction[]): void {
    for (const fn of [...listeners.current]) fn();
    const now = view.state;
    const p = latest.current;
    if (prev.doc !== now.doc && p.onChange) {
      let cached: string | null = null;
      p.onChange({
        type: 'change',
        get value() {
          if (cached === null) {
            cached = codecRef.current.serialize(now.doc);
            reported.current = cached;
          }
          return cached;
        },
        doc: now.doc,
        state: now,
        transactions: trs,
        name: p.name,
        target: handleRef.current!,
      });
    }
    if (!prev.selection.eq(now.selection))
      p.onSelectionChange?.(event('selectionchange'));
  }

  function openLinkAt(pos: number, ev: X11MouseEvent<DrawnNode>): boolean {
    const p = latest.current;
    if (!p.onLink) return false;
    const editing = !p.readOnly && !p.disabled;
    // editing, a plain click places the caret; Mod-click follows
    if (editing && !(ev.ctrlKey || ev.metaKey)) return false;
    const href = linkAt(view.state, pos);
    if (!href) return false;
    p.onLink(href, ev);
    return true;
  }

  const editLink = useCallback((): void => {
    const root = rootRef.current;
    const frame = root?.getClientRects()[0];
    if (!root || !frame || !view.state.schema.marks.link) return;
    const { from, to } = view.state.selection;
    const a = view.coordsAtPos(from);
    const b = view.coordsAtPos(to);
    const attrs = markAttrs(view.state, view.state.schema.marks.link);
    setLinkEdit({
      at: {
        x: a.left - frame.x,
        y: Math.min(a.top, b.top) - frame.y,
        width: Math.max(1, (a.top === b.top ? b.right : a.left) - a.left),
        height: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top),
      },
      draft: typeof attrs?.href === 'string' ? attrs.href : '',
    });
  }, [view]);

  const handle = useMemo<RichTextEditorHandle>(() => {
    const nodeType = (name: string) => view.state.schema.nodes[name];
    const markType = (name: string) => view.state.schema.marks[name];
    const itemType = () =>
      view.state.schema.nodes.list_item ?? view.state.schema.nodes.listItem;
    return {
      get view() {
        return view;
      },
      get state() {
        return view.state;
      },
      get schema() {
        return view.state.schema;
      },
      getValue(fmt) {
        const c = fmt
          ? codecFor(view.state.schema, fmt, latest.current.markdown)
          : codecRef.current;
        return c.serialize(view.state.doc);
      },
      setValue(value, options = {}) {
        const c = options.format
          ? codecFor(view.state.schema, options.format, latest.current.markdown)
          : codecRef.current;
        const doc = typeof value === 'string' ? c.parse(value) : value;
        if (typeof value === 'string' && !options.format)
          reported.current = value;
        replaceDocument(view, doc, options.addToHistory ?? false);
      },
      insertContent(value, fmt) {
        const doc =
          typeof value === 'string'
            ? (fmt
                ? codecFor(view.state.schema, fmt, latest.current.markdown)
                : codecRef.current
              ).parse(value)
            : value;
        // a whole document goes in as its blocks, open at both ends so a
        // single paragraph joins the one the caret is in
        const content =
          doc.type === view.state.schema.topNodeType
            ? doc.content
            : Fragment.from(doc);
        view.dispatch(
          view.state.tr
            .replaceSelection(Slice.maxOpen(content))
            .scrollIntoView(),
        );
      },
      run: (command) => view.run(command),
      can: (command) => command(view.state, undefined, view.asEditorView),
      isActive(name, attrs) {
        const mark = markType(name);
        if (mark) return isMarkActive(view.state, mark);
        const node = nodeType(name);
        return node ? isBlockActive(view.state, node, attrs) : false;
      },
      toggleMark(name, attrs) {
        const type = markType(name);
        return !!type && view.run(toggleMark(type, attrs));
      },
      setBlock(name, attrs) {
        const type = nodeType(name);
        return !!type && view.run(toggleBlockType(type, attrs));
      },
      toggleList(name) {
        const type = nodeType(name);
        const item = itemType();
        return !!type && !!item && view.run(toggleList(type, item));
      },
      toggleWrap(name) {
        const type = nodeType(name);
        return !!type && view.run(toggleWrap(type));
      },
      undo: () => view.run(undo),
      redo: () => view.run(redo),
      editLink,
      focus: () => view.focus(),
      blur: () => {
        (view.dom as unknown as { blur?: () => void } | null)?.blur?.();
      },
    };
  }, [view, editLink]);
  handleRef.current = handle;
  useImperativeHandle(props.ref, () => handle, [handle]);

  // The component's half of the view, refreshed every render; the view
  // acts only on what changed.
  useLayoutEffect(() => {
    view.configure(config);
  });

  // An app-owned state, handed back after each transaction.
  useLayoutEffect(() => {
    if (props.state && props.state !== view.state)
      view.updateState(props.state);
  }, [props.state, view]);

  // A controlled value: anything but what the editor last reported replaces
  // the document.
  useLayoutEffect(() => {
    const value = props.value;
    if (value === undefined || props.state || value === reported.current)
      return;
    reported.current = value;
    replaceDocument(view, codec.parse(value), false);
  }, [props.value, props.state, codec, view]);

  // New plugins (the app's, or the defaults' options): reconfigure, keeping
  // every plugin instance that is still there — and its state.
  const configured = useRef(plugins);
  useLayoutEffect(() => {
    if (props.state || plugins === configured.current) return;
    configured.current = plugins;
    view.updateState(view.state.reconfigure({ plugins }));
  }, [plugins, props.state, view]);

  const editorProps = props.editorProps;
  const firstProps = useRef(editorProps);
  useLayoutEffect(() => {
    if (editorProps === firstProps.current) return;
    firstProps.current = editorProps;
    view.setProps({
      ...editorProps,
      editable: view.props.editable,
      handleClick: view.props.handleClick,
    });
  }, [editorProps, view]);

  useEffect(() => () => view.destroy(), [view]);

  const editable = !readOnly && !disabled;
  // what a table measures its columns with; none on the mock backend
  const fonts =
    (useApp() as { fonts?: RenderContext['fonts'] } | null)?.fonts ?? null;
  const ctx = useMemo<RenderContext>(
    () => ({
      view,
      look,
      editable,
      fonts,
      ...(props.nodeViews ? { nodeViews: props.nodeViews } : null),
      ...(props.renderImage ? { renderImage: props.renderImage } : null),
    }),
    [view, look, editable, fonts, props.nodeViews, props.renderImage],
  );
  const blocks = useMemo(
    () => renderBlocks(state.doc, 0, ctx),
    [state.doc, ctx],
  );

  // --- input ---------------------------------------------------------------

  const onKeyDown = (ev: KeyboardEvent): void => {
    const p = latest.current;
    p.onKeyDown?.(ev);
    if (ev.defaultPrevented || p.disabled) return;
    const mac = view.primaryModifier === 'meta';
    const primary = mac ? ev.metaKey : ev.ctrlKey;
    const k = ev.keysym;
    if ((k === XK_RETURN || k === XK_KP_ENTER) && p.onSubmit) {
      const plain = !ev.shiftKey && !primary && !ev.altKey;
      // a plain Enter while a suggestion list shows rows takes a row: it is
      // the list's plugin's, a step further on
      const listing =
        plain && editable && !!suggestionState(view.state)?.items?.length;
      const submit =
        !listing &&
        (p.submitOnEnter
          ? plain && !inListOrCode(view.state)
          : primary && !ev.shiftKey);
      if (submit) {
        ev.preventDefault();
        p.onSubmit(event('submit'));
        return;
      }
    }
    if (
      primary &&
      !ev.altKey &&
      !ev.shiftKey &&
      k === 0x6b /* k */ &&
      editable
    ) {
      ev.preventDefault();
      editLink();
      return;
    }
    if (k === XK_ESCAPE && linkEdit) setLinkEdit(null);
  };

  const onMouseDown = (ev: X11MouseEvent): void => {
    latest.current.onMouseDown?.(ev);
    if (ev.defaultPrevented || latest.current.disabled) return;
    if (view.mouseDown(ev)) ev.preventDefault();
  };

  const setRoot = useCallback((node: unknown) => {
    rootRef.current = (node as DrawnNode | null) ?? null;
  }, []);
  const setScroller = useCallback(
    (node: unknown) =>
      view.attachScroller((node as ScrollableNode | null) ?? null),
    [view],
  );

  // --- chrome --------------------------------------------------------------

  let chrome: ReactNode = null;
  if (typeof toolbar === 'function') {
    chrome = toolbar(handle);
  } else if (toolbar) {
    const items = toolbarItems(schema, {
      link: () => {
        editLink();
        return true;
      },
    });
    chrome = h(Toolbar, {
      entries: resolveToolbar(
        toolbar === true ? DEFAULT_TOOLBAR : toolbar,
        items,
      ),
      state,
      run: (command: Command) => {
        view.run(command);
        view.focus();
      },
      look,
      disabled: !editable,
      ...(styles?.toolbar ? { style: styles.toolbar } : null),
    });
  }

  const closeLink = (): void => {
    setLinkEdit(null);
    view.focus();
  };
  const applyLink = (href: string): void => {
    const target = href.trim();
    view.run(setLink(target === '' ? null : target));
    closeLink();
  };
  const linkPopup =
    linkEdit &&
    hx(
      'popup',
      {
        theme: theme as Record<string, string | number>,
        anchor: {
          to: rootRef as unknown as React.RefObject<DrawnNode | null>,
          at: linkEdit.at,
          placement: 'bottom',
        },
        onDismiss: closeLink,
      },
      hx(
        'box',
        {
          style: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            padding: 6,
            borderWidth: 1,
            borderColor: look.border,
            borderRadius: look.radius,
            backgroundColor: look.surface,
          },
        },
        hx('textinput', {
          value: linkEdit.draft,
          placeholder: 'https://',
          autoFocus: true,
          style: { width: 260 },
          onChange: (ev) =>
            setLinkEdit((cur) => (cur ? { ...cur, draft: ev.value } : cur)),
          onSubmit: (ev) => applyLink(ev.value),
          onKeyDown: (ev) => {
            if (ev.keysym === XK_ESCAPE) {
              ev.preventDefault();
              closeLink();
            }
          },
        }),
      ),
    );

  // The suggestion list, drawn from the plugin's state and nothing else
  // (./suggest.ts) — so an app that owns the EditorState gets it too. It hangs
  // off the textblock the trigger is in, at the trigger, so it follows the
  // text as the document scrolls and unmaps while the text is out of view.
  // It never takes focus: a press on a row takes the row, and the caret
  // stays in the editor.
  const suggestion = suggestionState(state);
  const firstRow = useRef(0);
  const rowsShown = focused && editable && !!suggestion?.items?.length;
  const anchor =
    rowsShown && suggestion ? view.anchorAt(suggestion.from) : null;
  let suggestionPopup: ReactNode = null;
  if (suggestion?.items && anchor) {
    const { items, selected } = suggestion;
    // the window of rows moves only as far as keeps the highlight in it
    let first = Math.min(
      firstRow.current,
      Math.max(0, items.length - SUGGESTION_PAGE),
    );
    if (selected < first) first = selected;
    if (selected >= first + SUGGESTION_PAGE)
      first = selected - SUGGESTION_PAGE + 1;
    firstRow.current = first;
    // a suggester may draw its rows itself; the row box — the highlight
    // behind it, the press on it — stays the editor's
    const custom = suggesterFor(state)?.renderItem;
    const rowHeight = Math.round(look.size + 12);
    const rows = items.slice(first, first + SUGGESTION_PAGE).map((item, i) => {
      const index = first + i;
      const on = index === selected;
      if (custom) {
        return hx(
          'box',
          {
            key: `${index} ${item.label}`,
            style: {
              flexDirection: 'row',
              alignItems: 'center',
              minHeight: rowHeight,
              paddingLeft: 8,
              paddingRight: 8,
              borderRadius: Math.max(0, look.radius - 2),
              backgroundColor: on ? look.accent : 'transparent',
              ...(on
                ? null
                : { ':hover': { backgroundColor: tint(look.text, 0.08) } }),
            },
            onMouseDown: (ev: X11MouseEvent) => {
              ev.preventDefault();
              view.run(acceptSuggestion(index));
            },
          },
          custom(item, { selected: on, query: suggestion.query }),
        );
      }
      return hx(
        'box',
        {
          key: `${index} ${item.label}`,
          style: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            height: rowHeight,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: Math.max(0, look.radius - 2),
            backgroundColor: on ? look.accent : 'transparent',
            ...(on
              ? null
              : { ':hover': { backgroundColor: tint(look.text, 0.08) } }),
          },
          onMouseDown: (ev: X11MouseEvent) => {
            ev.preventDefault();
            view.run(acceptSuggestion(index));
          },
        },
        hx(
          'text',
          {
            style: {
              flexGrow: 1,
              fontFamily: look.family,
              fontSize: look.size,
              color: on ? look.accentText : look.text,
            },
          },
          item.label,
        ),
        item.detail
          ? hx(
              'text',
              {
                style: {
                  fontFamily: look.family,
                  fontSize: Math.max(10, look.size - 2),
                  color: on ? look.accentText : look.muted,
                },
              },
              item.detail,
            )
          : null,
      );
    });
    suggestionPopup = hx(
      'popup',
      {
        theme: theme as Record<string, string | number>,
        anchor: { to: anchor.node, at: anchor.at, placement: 'bottom' },
        minWidth: 200,
        maxWidth: 420,
      },
      hx(
        'box',
        {
          style: {
            flexGrow: 1,
            flexDirection: 'column',
            padding: 4,
            borderWidth: 1,
            borderColor: look.border,
            borderRadius: look.radius,
            backgroundColor: look.surface,
          },
        },
        ...rows,
      ),
    );
  } else {
    firstRow.current = 0;
  }

  const frame: Style = {
    flexDirection: 'column',
    borderWidth: 1,
    borderColor: look.border,
    borderRadius: look.radius,
    backgroundColor: look.background,
    overflow: 'hidden',
    ...(editable
      ? {
          ':focus-within': {
            borderColor: String(theme.borderFocus ?? look.accent),
          },
        }
      : null),
  };

  return h(
    ROOT_ELEMENT,
    {
      ref: setRoot,
      host: view,
      focusable: !disabled,
      disabled,
      autoFocus,
      'aria-label': props['aria-label'] ?? placeholder,
      'data-testname': props['data-testname'],
      style: style
        ? [frame, ...(Array.isArray(style) ? style : [style])]
        : frame,
      onKeyDown,
      onMouseDown,
      onMouseMove: (ev: X11MouseEvent) => {
        if (view.mouseMove(ev)) ev.preventDefault();
      },
      onMouseUp: () => view.mouseUp(),
      onContextMenu: (ev: X11MouseEvent) => {
        if (ev.defaultPrevented || latest.current.disabled) return;
        view.contextMenu(ev);
        ev.preventDefault();
      },
      onFocus: props.onFocus,
      onBlur: props.onBlur,
    },
    chrome,
    hx(
      'box',
      {
        ref: setScroller,
        // a press inside focuses the editor, not the viewport it scrolls in
        focusable: false,
        // `flexBasis: 'auto'` is load-bearing: a scroll box that grows
        // takes a zero basis, so an editor nobody gave a height collapsed
        // to its border. With it the viewport is its content's height — a
        // composer grows as it is typed in, up to the frame's `maxHeight`,
        // and past that it shrinks to fit and scrolls; given a height or a
        // `flexGrow`, it fills.
        style: {
          overflow: 'scroll',
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: 'auto',
          flexDirection: 'column',
        },
      },
      hx(
        'box',
        {
          style: {
            flexDirection: 'column',
            gap: look.blockGap,
            padding: Math.round(look.size * 0.85),
            flexGrow: 1,
            ...styles?.content,
          },
        },
        ...blocks,
      ),
    ),
    linkPopup,
    suggestionPopup,
  );
}

// --- the elements, for JSX ---------------------------------------------------

/** The raw `<richeditor>`'s props. Structural on purpose — see the note on
 *  `CodeEditorElementProps` in `../code-editor/index.ts`. */
export interface RichEditorElementProps {
  host?: unknown;
  focusable?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  style?: Style | Style[];
  ref?: Ref<unknown>;
  children?: ReactNode;
  onKeyDown?: (ev: KeyboardEvent) => void;
  onMouseDown?: (ev: X11MouseEvent) => void;
  onMouseMove?: (ev: X11MouseEvent) => void;
  onMouseUp?: (ev: X11MouseEvent) => void;
  onContextMenu?: (ev: X11MouseEvent) => void;
  onFocus?: (ev: FocusEvent) => void;
  onBlur?: (ev: FocusEvent) => void;
}

/** The raw `<richeditortext>`'s props. */
export interface RichEditorTextElementProps {
  runs: TextRun[];
  map?: unknown;
  node?: unknown;
  blockKey?: string;
  host?: unknown;
  wrap?: boolean;
  style?: Style | Style[];
  ref?: Ref<unknown>;
}

declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      richeditor: RichEditorElementProps;
      richeditortext: RichEditorTextElementProps;
    }
  }
}

// --- the rest of the surface -------------------------------------------------

export {
  ROOT_ELEMENT as RICH_EDITOR_ELEMENT,
  TEXT_ELEMENT as RICH_EDITOR_TEXT_ELEMENT,
};
export { RichEditorView };
export type { EditorView };
export type { ViewProps, BlockDecorations, MoveUnit } from './view.js';
export { schema, nodes, marks } from './schema.js';
export { defaultPlugins, editingKeymap, markdownInputRules } from './keymap.js';
// What a plugin's `handleKeyDown` is really handed: ProseMirror's
// declarations say DOM `KeyboardEvent`, which this platform has no values of.
export type { DefaultPluginOptions, DomKeyEvent } from './keymap.js';
export {
  dedentCode,
  goToCell,
  indentCode,
  insertHorizontalRule,
  isBlockActive,
  isMarkActive,
  markAttrs,
  setLink,
  setTaskChecked,
  splitItem,
  toggleBlockType,
  toggleList,
  toggleTaskList,
  toggleWrap,
} from './commands.js';
export {
  docFromMarkdown,
  markdownCodec,
  markdownFromDoc,
  docFromText,
  textFromDoc,
} from './markdown.js';
export type { MarkdownCodec } from './markdown.js';
export { docFromHTML, htmlFromContent } from './html.js';
export { DEFAULT_TOOLBAR, toolbarItems } from './toolbar.js';
export type { ToolbarEntry, ToolbarItem, ToolbarItemName } from './toolbar.js';
export {
  acceptSuggestion,
  dismissSuggestion,
  filterSuggestions,
  selectSuggestion,
  suggesterFor,
  suggestionState,
  suggestions,
} from './suggest.js';
export type {
  Suggester,
  SuggestionItem,
  SuggestionQuery,
  SuggestionRow,
  SuggestionState,
} from './suggest.js';
export {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  columnAlign,
  deleteColumn,
  deleteRow,
  deleteTable,
  insertTable,
  isInTable,
  setColumnAlign,
  tableRepair,
} from './tables.js';
export type { ColumnAlign } from './tables.js';
export type { ImageInfo, NodeViewProps } from './render.js';
export type { MarkStyle } from './look.js';
export type { RunStyle } from './inline.js';
