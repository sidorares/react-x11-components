// `<Html>` — a static HTML + CSS renderer with selectable text, a resource
// seam, a script seam, and real widgets for form controls.
//
// The engine is `node.ts` and the files under `css/` and `layout/`; this file
// is the React half: props, the theme, the seams, and the controls mounted
// beside the element. See `docs/prd-html.md` for why the element draws the
// document rather than composing it out of `<box>`es, and `docs/components/
// html.md` for the reference.
//
// **What it is not.** It does not fetch anything, it does not execute
// anything, and it never will: `onResource` and `onScript` are how an
// application supplies both, and a document rendered without them cannot
// reach the network or the disk. That is the whole security posture, and it
// is a property of the design rather than a setting.
import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useTheme } from 'react-x11';
import type { DrawnNode, MouseEvent as X11MouseEvent, Rect } from 'react-x11';
import { tint } from 'react-x11/style';
import type { Style } from 'react-x11/style';

import type {} from 'react-x11/jsx-runtime';

import { useLinkClicks, useSelectionMenu } from '../richtext/index.js';
import { useFontPrewarm } from '../internal/prewarm.js';
import { hx } from './hx.js';
import type { Document, Element } from './dom.js';
import { ELEMENT, HtmlViewNode, registerHtmlView } from './node.js';
import type { HtmlViewProps, ScriptRequest } from './node.js';
import type { RootLook } from './css/style.js';
import type { ControlRect } from './controls.js';
import type { FormSubmission } from './form.js';
import { useForms } from './widgets.js';
import type { ResourceRequest, ResourceResult } from './resources.js';

export {
  ELEMENT as HTMLVIEW_ELEMENT,
  HtmlViewNode,
  registerHtmlView,
} from './node.js';
export type { HtmlViewProps, ScriptRequest } from './node.js';
export type { ResourceRequest, ResourceResult } from './resources.js';
export type { BareField, ControlRect } from './controls.js';
export type {
  FormEnctype,
  FormMethod,
  FormSubmission,
  SubmitContext,
} from './form.js';
export { formSubmission } from './form.js';
export type { ComputedStyle, RootLook } from './css/style.js';
export type {
  AnyNode,
  ChildNode,
  Document,
  Element,
  ParentNode,
} from './dom.js';
export {
  appendChild,
  createElement as createHtmlElement,
  createText,
  parseFragment,
  removeNode,
  replaceNode,
} from './dom.js';

const h = React.createElement;

// The one side effect, at this component's own module scope — the rule the
// whole tree-shaking contract rests on (AGENTS.md).
registerHtmlView();

// --- props -----------------------------------------------------------------

/** What the document may do to the outside world. Nothing, by default. */
export interface HtmlProps {
  /** The HTML. Append to it as chunks stream in. */
  source: string;
  /**
   * Whether more source may still arrive (default true, matching
   * `<Markdown partial>`). While true the parser is left open and a `source`
   * that extends the last one is written as a delta, so the nodes already
   * parsed keep their identity and their layout. Set false when the stream
   * ends.
   *
   * False ends the parse, and that is final: a later `source` re-parses even
   * when it extends the last one. An editor handing over the whole document
   * on every keystroke wants the default.
   */
  partial?: boolean;
  /** Mouse selection, Ctrl+A / Ctrl+C, PRIMARY. Default true. */
  selectable?: boolean;
  /**
   * Whether the document's CSS animations run. Default true. False draws
   * each as it stands once it has run one iteration at no length — the
   * frame it ends on where it fills forwards — which is what a capture
   * that has to come out the same every time wants.
   */
  animate?: boolean;
  /** Extra author stylesheets, applied after the document's own. */
  stylesheet?: string | string[];
  /**
   * The encoding the host decoded `source` from, as a label (`'shift_jis'`,
   * `'windows-1251'`). A stylesheet `onResource` hands over as bytes, with no
   * byte order mark, charset or `@charset` of its own, is decoded with it, as
   * CSS says a sheet is in its document's encoding. Default UTF-8.
   */
  charset?: string;
  /**
   * The URL the document came from. Given one — or a document with an
   * absolute `<base href>` — every URL the document names reaches
   * `onResource` and `onLink` absolute: resolved against its `<base href>`
   * or this, and a `url()` in a linked stylesheet against the stylesheet's
   * own URL, as a browser resolves it. Absent, URLs are handed over as the
   * document wrote them.
   *
   * Nothing is fetched because of it: it says where relative URLs point,
   * and `onResource` still decides whether anything goes there.
   */
  baseUrl?: string | null;
  /**
   * An external resource is wanted — an `<img src>`, a `<link rel=stylesheet>`
   * or an `@import`, or a font an `@font-face` declares and the document
   * uses. Return the bytes or the text, or a promise of them, or `null` to
   * decline. A stylesheet's bytes are decoded as CSS says, from the
   * `charset` the protocol named, if the host passes it on, and its `url`,
   * if the host passes that, is where it came from after redirects.
   *
   * **Absent, nothing loads.** This component has no network and no
   * filesystem of its own; images render as a frame, linked stylesheets are
   * skipped and text is set in the fonts the system has. The host is the one
   * that knows its cache, its proxy and whether this document is trusted.
   */
  onResource?: (
    request: ResourceRequest,
  ) => Promise<ResourceResult | null> | ResourceResult | null;
  /**
   * A `<script>` was found. Handed over **unparsed and unevaluated** — the
   * type, the `src`, the text, the element — for an application that brings
   * its own engine. Nothing here reads it.
   */
  onScript?: (script: ScriptRequest) => void;
  /**
   * A link was activated. Absent means clicks do nothing: this component
   * never navigates by itself. The `href` is resolved against the
   * document's base where it has one (`baseUrl`), and as written where not.
   */
  onLink?: (href: string, ev: X11MouseEvent<DrawnNode>) => void;
  /** The parsed document, each time it is re-parsed — the DOM handle. */
  onDocument?: (document: Document) => void;
  /**
   * A form control changed, or a `<button>` was pressed — reported with its
   * `value`. The element is the one in the DOM, so a handler that wants to
   * keep the value writes it back with `setAttribute`-shaped mutation and
   * calls the handle's `refresh()`.
   */
  onControlChange?: (element: Element, value: string | boolean) => void;
  /**
   * A form was submitted — a submit button pressed, or Enter in one of its
   * text fields. Handed over as the request it makes: the method, the URL
   * (resolved as `onLink`'s `href` is, and for a GET with the form's entries
   * as its query), a POST's encoded body and its content type, and the
   * entries themselves. Absent means submitting does nothing: this
   * component never sends anything by itself, any more than it navigates.
   */
  onSubmit?: (submission: FormSubmission) => void;
  /** Base text style. Defaults: theme `fontSize` (14), `sans-serif`. */
  fontSize?: number;
  fontFamily?: string;
  /** Code font. Default `'monospace'` — there is no theme token for it. */
  monoFamily?: string;
  /** Selection band fill. Default: theme accent at 35% opacity. */
  selectionColor?: string;
  /** The root `<box>`'s style. */
  style?: Style | Style[];
  /**
   * A handle on the element — what `useHtmlHandle()` supplies. React 19
   * takes `ref` as an ordinary prop on a function component, so it is
   * declared here rather than needing `forwardRef`; it is forwarded to
   * `<htmlview>`, so what lands in it is the node that owns the document.
   */
  ref?: React.Ref<unknown>;
  'data-testname'?: string;
}

/** What an application holds to read or change the document it rendered. */
export interface HtmlHandle {
  /** The live DOM. Mutable: this is domhandler's tree, and `domutils` speaks
   *  it, as do the helpers this module re-exports. */
  readonly document: Document | null;
  /**
   * The DOM changed — restyle, re-lay-out and repaint.
   *
   * Explicit rather than observed, and that is the trade the component makes
   * on purpose: watching a plain object graph for mutations costs a proxy per
   * node, which would tax the static render that this is built to make fast
   * in order to speed up the path it is not. Mutation is supported; it is not
   * what the performance budget was spent on.
   */
  refresh(): void;
  /** The element under a point, in the window's coordinates. */
  elementAt(x: number, y: number): Element | null;
  /** The link under a point, in the window's coordinates — resolved, as
   *  `onLink` is handed one — for a status bar, or a menu on a link. */
  hrefAt(x: number, y: number): string | null;
  /**
   * Where an element is, in logical pixels from the document's top left:
   * the space the offset of a box scrolling the document is in, so a link
   * to `#section` is `scroller.scrollTo({ y: handle.elementRect(el).y })`.
   * A block's border box; an inline element's across its fragments, padding
   * and border included, as `getBoundingClientRect` measures it, and as
   * tall as its lines. Null for an element with no box.
   */
  elementRect(element: Element): Rect | null;
  /** The document's `<title>`, if it had one. */
  readonly title: string | null;
  /** The URL the document's relative URLs resolve against — its
   *  `<base href>`, or `baseUrl` — or null where it has none. */
  readonly base: string | null;
}

// --- the look ---------------------------------------------------------------

function deriveLook(
  theme: Record<string, unknown>,
  props: HtmlProps,
): RootLook {
  const text = String(theme.text ?? '#2d3436');
  return {
    color: text,
    fontFamily: props.fontFamily ?? 'sans-serif',
    fontSize: props.fontSize ?? Number(theme.fontSize ?? 14),
    monoFamily: props.monoFamily ?? 'monospace',
    linkColor: String(theme.accent ?? '#2980b9'),
    borderColor: String(theme.border ?? '#b2bec3'),
    mutedColor: String(theme.textMuted ?? '#7f8c8d'),
    background: String(theme.background ?? 'white'),
    colorScheme: theme.scheme === 'dark' ? 'dark' : 'light',
    surface: String(theme.surface ?? theme.background ?? 'white'),
    controlPadY: Number(theme.paddingY ?? 6),
    controlBorder: Number(theme.borderWidth ?? 1),
    controlRadius: Number(theme.radius ?? 4),
    // not `fontSize` and `fontFamily`, which a host sets to the web's
    // `medium` and the face it reads pages in
    controlFontSize: Number(theme.fontSize ?? 14),
    controlFontFamily: String(theme.fontFamily ?? 'sans-serif'),
    ...(typeof theme.focusRing === 'string' && { focusRing: theme.focusRing }),
    ...(typeof theme.focusRingWidth === 'number' && {
      focusRingWidth: theme.focusRingWidth,
    }),
    ...(typeof theme.focusRingOffset === 'number' && {
      focusRingOffset: theme.focusRingOffset,
    }),
  };
}

/** What a document sets in the code face: the elements the UA sheet puts in
 *  it, and a style sheet that names `monospace`, in either case. */
const CODE_MARKUP = /<(?:code|pre|kbd|samp|tt|listing|xmp)\b|monospace/i;

/**
 * The code face, once the source holds code, and null before. A source that
 * grows is read once, from a little before where it was last read to find a
 * name a chunk split, so a document streamed in thousands of pieces is not
 * read again at each one; a source that does not start with the last is
 * read whole. Once found, found: warming a face twice warms nothing.
 */
function useCodeFamily(source: string, family: string): string | null {
  const read = React.useRef({ source: '', found: false });
  const seen = read.current;
  if (!seen.found && source !== seen.source) {
    const from = source.startsWith(seen.source)
      ? Math.max(0, seen.source.length - 'monospace'.length)
      : 0;
    seen.found = CODE_MARKUP.test(from ? source.slice(from) : source);
    seen.source = source;
  }
  return seen.found ? family : null;
}

// --- the component ----------------------------------------------------------

/**
 * A rendered HTML document. Text selects across the whole of it — mouse
 * (double/triple click for word and block), Ctrl+A, Ctrl+C, and X11 PRIMARY
 * on release.
 *
 * ```jsx
 * <box style={{ overflow: 'scroll', flexGrow: 1 }}>
 *   <Html source={html}
 *         onLink={(href) => openInBrowser(href)}
 *         onResource={(r) => r.kind === 'image' ? loadImage(r.url) : null} />
 * </box>
 * ```
 */
export function Html(props: HtmlProps): ReactElement {
  const {
    source,
    partial = true,
    selectable = true,
    animate = true,
    stylesheet,
    charset,
    baseUrl,
    onLink,
    onResource,
    onScript,
    onDocument,
    onControlChange,
    onSubmit,
    style,
  } = props;

  const theme = useTheme() as unknown as Record<string, unknown>;
  const links = useLinkClicks(onLink);
  const menu = useSelectionMenu(selectable);

  // The element, for the document's base when a form is submitted, as well
  // as wherever the application's `ref` wants it.
  const viewNode = React.useRef<HtmlViewNode | null>(null);
  const outerRef = props.ref;
  const viewRef = React.useCallback(
    (node: HtmlViewNode | null) => {
      viewNode.current = node;
      if (typeof outerRef === 'function') outerRef(node);
      else if (outerRef) (outerRef as React.RefObject<unknown>).current = node;
    },
    [outerRef],
  );

  const look = React.useMemo(
    () => deriveLook(theme, props),
    [theme, props.fontSize, props.fontFamily, props.monoFamily],
  );
  // a document with code in it sets that code in the mono family, and its
  // render is the head start its first layout would otherwise wait on the
  // system's font matcher for (`useFontPrewarm`)
  useFontPrewarm(useCodeFamily(source, look.monoFamily));

  const documentRef = React.useRef<Document | null>(null);
  const [controls, setControls] = React.useState<ControlRect[]>([]);
  const [domRevision, setDomRevision] = React.useState(0);
  const forms = useForms({
    view: viewNode,
    baseUrl,
    onControlChange,
    onSubmit,
    touch: () => setDomRevision((n) => n + 1),
  });

  const handleDocument = React.useCallback(
    (doc: Document) => {
      documentRef.current = doc;
      onDocument?.(doc);
    },
    [onDocument],
  );

  // The controls the element reports are held as state because they are React
  // elements: the element decides *where* a widget goes, React decides what it
  // is. Same split as `<Flow onNodeBodies>`, and for the same reason — a
  // painted control is a picture of a control.
  const handleControls = React.useCallback((rects: ControlRect[]) => {
    setControls(rects);
  }, []);

  const selectionColor =
    props.selectionColor ?? tint(String(theme.accent ?? '#2980b9'), 0.35);

  const viewProps: HtmlViewProps & { ref?: React.Ref<unknown> } = {
    source,
    complete: !partial,
    stylesheet,
    charset,
    baseUrl,
    look,
    selectionColor,
    onResource,
    onScript,
    onDocument: handleDocument,
    onControls: handleControls,
    domRevision,
    animate,
    ref: viewRef as React.Ref<unknown>,
    // grown with the component, where an application grows it: the root's
    // background covers the whole of it, as a page's covers the window
    style: { alignSelf: 'stretch', flexGrow: 1 },
  };

  const children: ReactNode[] = [
    h(ELEMENT, { key: 'view', ...viewProps } as Record<string, unknown>),
  ];
  children.push(...forms.render(controls, look));

  const rootStyle: Style = { flexDirection: 'column', position: 'relative' };
  return hx(
    'box',
    {
      style: style
        ? [rootStyle, ...(Array.isArray(style) ? style : [style])]
        : rootStyle,
      // The whole selection: a drag across the document, word and block
      // granularity, Ctrl+A, Ctrl+C, PRIMARY on release, and one visible
      // selection per application. One element answers for every paragraph,
      // so there is nothing per-block to thread through.
      selectable,
      selectionColor: props.selectionColor,
      ...links,
      onMouseDown: (ev: X11MouseEvent<DrawnNode>) => {
        links.onMouseDown(ev);
        forms.onMouseDown(ev);
      },
      onMouseUp: (ev: X11MouseEvent<DrawnNode>) => {
        links.onMouseUp(ev);
        forms.onMouseUp(ev);
      },
      ...menu,
      'data-testname': props['data-testname'],
    } as Record<string, unknown>,
    ...children,
  );
}

/**
 * A handle on a rendered document, for reading or changing it.
 *
 * ```jsx
 * const handle = useHtmlHandle();
 * <Html source={html} ref={handle.ref} />
 * // later
 * handle.document?.children …           // domhandler's tree
 * handle.refresh();                      // and the view catches up
 * ```
 */
export function useHtmlHandle(): HtmlHandle & { ref: React.Ref<unknown> } {
  const nodeRef = React.useRef<HtmlViewNode | null>(null);
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  return React.useMemo(
    () => ({
      ref: nodeRef as unknown as React.Ref<unknown>,
      get document() {
        return nodeRef.current?.document ?? null;
      },
      get title() {
        return nodeRef.current?.title ?? null;
      },
      get base() {
        return nodeRef.current?.documentBase ?? null;
      },
      refresh: () => {
        nodeRef.current?.touchDocument();
        force();
      },
      elementAt: (x: number, y: number) =>
        nodeRef.current?.elementAtPoint(x, y) ?? null,
      hrefAt: (x: number, y: number) =>
        nodeRef.current?.hrefAtPoint(x, y) ?? null,
      elementRect: (element: Element) =>
        nodeRef.current?.elementRect(element) ?? null,
    }),
    [],
  );
}

declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      htmlview: HtmlViewProps & {
        key?: string | number;
        ref?: React.Ref<unknown>;
      };
    }
  }
}
