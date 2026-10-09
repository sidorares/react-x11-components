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
import { useSystemAppearance, useTheme } from 'react-x11';
import type {
  DrawnNode,
  KeyboardEvent as X11KeyboardEvent,
  MouseEvent as X11MouseEvent,
  Rect,
  WheelEvent as X11WheelEvent,
} from 'react-x11';
import { tint } from 'react-x11/style';
import type { Style } from 'react-x11/style';

import type {} from 'react-x11/jsx-runtime';

import { useLinkClicks, useSelectionMenu } from '../richtext/index.js';
import { useFontPrewarm } from '../internal/prewarm.js';
import { hx } from './hx.js';
import { flatParentOf, isElement, tagOf } from './dom.js';
import type { Document, Element, HtmlChange } from './dom.js';
import { ELEMENT, HtmlViewNode, registerHtmlView } from './node.js';
import type {
  DocumentInteraction,
  HtmlViewProps,
  ScriptRequest,
} from './node.js';
import {
  documentPoint,
  domButton,
  domButtons,
  domKey,
  fireDomEvent,
  modifiersOf,
  NO_MODIFIERS,
} from './dom-events.js';
import type {
  DomEventHandler,
  DomEventInit,
  HtmlDomEventType,
} from './dom-events.js';
import { inputType, isDisabled } from './form.js';
import type { RootLook } from './css/style.js';
import type { ViewportOverflow } from './css/cascade.js';
import type { ControlRect } from './controls.js';
import type { FormSubmission } from './form.js';
import { useForms } from './widgets.js';
import { useVideos } from './videos.js';
import { useEmbedded } from './embedded.js';
import type { RenderEmbedded } from './embedded.js';
import { syntheticClick, useFocusStops, useFocusableMarkup } from './stops.js';
import type { ResourceRequest, ResourceResult } from './resources.js';

export {
  ELEMENT as HTMLVIEW_ELEMENT,
  HtmlViewNode,
  registerHtmlView,
} from './node.js';
export type { HtmlViewProps, ScriptRequest } from './node.js';
export type {
  DomEventHandler,
  HtmlDomEvent,
  HtmlDomEventType,
} from './dom-events.js';
export type {
  ResourceRequest,
  ResourceResult,
  VideoSource,
} from './resources.js';
export type { BareField, ControlRect } from './controls.js';
export type { EmbeddedKind, EmbeddedRect, MediaRect } from './media.js';
export type { RenderEmbedded } from './embedded.js';
export type {
  FormEnctype,
  FormMethod,
  FormSubmission,
  SubmitContext,
} from './form.js';
export { formSubmission } from './form.js';
export type { ComputedStyle, RootLook } from './css/style.js';
export type { ViewportOverflow } from './css/cascade.js';
export type {
  AnyNode,
  ChildNode,
  Document,
  Element,
  HtmlChange,
  ParentNode,
  ShadowRoot,
  ShadowRootMode,
} from './dom.js';
export {
  appendChild,
  attachShadow,
  createElement as createHtmlElement,
  createText,
  parseFragment,
  removeNode,
  replaceNode,
  shadowRootOf,
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
   * A document to draw in place of parsing `source`, which is then not
   * read: one a host holds and changes, as a browser holds a frame's
   * document a page writes into. Its changes are told through the handle's
   * `refresh`, as a script's are. A browser draws an `<iframe>` with it
   * (`renderEmbedded`).
   */
  document?: Document;
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
   * that has to come out the same every time wants. It does not answer
   * `(prefers-reduced-motion: reduce)`: the page held at rest is the one
   * that animates, under `no-preference`, and `reducedMotion` says which
   * page that is.
   */
  animate?: boolean;
  /**
   * Whether the desktop has asked for less motion, which
   * `@media (prefers-reduced-motion)` is answered from: true takes the
   * page's `reduce` branch, false its `no-preference` one. Default: the
   * desktop's own setting, `useSystemAppearance().reducedMotion` — macOS's
   * Reduce motion, GNOME's animations switch — followed as it changes, as
   * a browser follows it. Set it where the application decides instead: a
   * preference of its own, or a capture that has to come out the same on
   * every machine.
   */
  reducedMotion?: boolean;
  /**
   * The colour scheme a document that does not say which it is drawn in —
   * `color-scheme: normal`, the initial value — is drawn in: the user
   * agent's default (CSS Color Adjust 1, 2.1). Default: the palette's, since
   * the palette is this renderer's look, so a document dropped into a dark
   * application is drawn dark. A host that shows the web as a browser does
   * sets `'light'`: every browser draws a page that says nothing about its
   * scheme light, on white, whatever the reader prefers — and its form
   * controls light, in a browser's colours rather than a dark palette's
   * widgets. The palette still
   * answers `@media (prefers-color-scheme)` and the scheme `light dark`
   * takes, which are the reader's preference.
   */
  defaultColorScheme?: 'light' | 'dark';
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
   *
   * Its fragment names the document's `:target`: the element whose id it
   * is, or the `<a>` it is the name of. A host that follows a link to
   * `#section` passes the same URL with that fragment, which resolves
   * nothing differently and restyles only where a rule tests `:target`;
   * a document with no URL can be given a fragment alone, `'#section'`.
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
   * A `<video>`'s source is asked for as `kind: 'video'`, with the `type`
   * its `<source>` gives: answer `{ kind: 'video', src }` for core's
   * `<video>` to play with the platform's player — where
   * `useSupports('mediaPlayback')` says there is one — or `{ kind: 'video',
   * frames }` with a `VideoFrames` sink the host decodes it into. Declined,
   * the next `<source>` is asked for, and with none left the video is its
   * poster.
   *
   * **Absent, nothing loads.** This component has no network and no
   * filesystem of its own; images render as a frame, linked stylesheets are
   * skipped, videos show their posters and text is set in the fonts the
   * system has. The host is the one that knows its cache, its proxy and
   * whether this document is trusted.
   */
  onResource?: (
    request: ResourceRequest,
  ) => Promise<ResourceResult | null> | ResourceResult | null;
  /**
   * A `<script>` was found. Handed over **unparsed and unevaluated** — the
   * type, the `src`, the text, the element — for an application that brings
   * its own engine. Nothing here reads it. Called while the element is
   * reading its props, so a host queues the script and runs it later —
   * after `onParsed`, once the handle's `scriptsUnblocked` says the sheets
   * before it are in — rather than in the callback.
   */
  onScript?: (script: ScriptRequest) => void;
  /**
   * Whether the host runs the document's scripts: an application that
   * brings an engine says so, and the document is drawn as a browser draws
   * one that runs JavaScript — a `<noscript>` is drawn as nothing, nothing
   * in it is asked for through `onResource` or handed to `onScript`, and
   * `@media (scripting: enabled)` holds. **This component runs nothing
   * either way.** Default false: a `<noscript>` is drawn, as it is with
   * JavaScript off.
   */
  scripting?: boolean;
  /**
   * Something happened to the document, before this component does what it
   * does about it: a `click` before a link is followed, a button pressed or
   * a box ticked; a `keydown` before a field types it; a `submit` before
   * the entries are built and `onSubmit` is called; `input`, `change`,
   * `focusin`, `focusout`, `toggle` as they happen. Synchronous, and
   * returning `false` from it cancels an event that can be — the page's
   * `preventDefault()`. "Events before their defaults" in the docs has
   * the order.
   */
  onDomEvent?: DomEventHandler;
  /** The parse has ended: every element is in the tree. Once a document,
   *  a microtask after the source that ended it — when a host runs the
   *  scripts it was handed, each once the sheets before it are in
   *  (`scriptsUnblocked`), and then tells `DOMContentLoaded`. */
  onParsed?: () => void;
  /** Everything the document asked for has arrived or failed — counted
   *  from its first complete layout, since a background, a font or a
   *  chosen image source is asked for only as one finds it. Once a
   *  document: `load`'s moment. */
  onLoaded?: () => void;
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
  /**
   * How the document asks to be scrolled: the `overflow` its root element
   * gives the viewport, or its `<body>` where the root's is `visible` (CSS
   * Overflow 3, 3.3), as a viewport uses it — `visible` is `auto` there and
   * `clip` is `hidden`. Reported once the document is first laid out, and
   * again when a build changes it.
   *
   * The viewport is the host's: whatever box scrolls this component. The
   * element lays the root and the body out as `visible` either way, and
   * does nothing with the answer itself. A host that shows the web as a
   * browser does hides the scrollbar of an axis that is `hidden` and lets
   * the reader scroll it with neither the wheel nor the keys, though a
   * link to a fragment still scrolls there — what Acid2's `html { overflow:
   * hidden }` asks of it.
   */
  onViewportOverflow?: (overflow: ViewportOverflow) => void;
  /**
   * What to show in an `<iframe>`, a `<canvas>` or an `<embed>`: called with
   * where the element's content box is, in this component's space, and what
   * it returns is mounted there, filling it, beside the document as a
   * `<video>`'s player is — cut by what clips the element, faded as it is
   * faded, and kept mounted, the same node, while the element moves.
   * Nothing is loaded or drawn for one by this component: absent, or
   * answering null, the box is the empty one the document lays out. A
   * browser mounts another `<Html>` with the frame's document in it.
   */
  renderEmbedded?: RenderEmbedded;
  /** Base text style. Defaults: theme `fontSize` (14), `sans-serif`. */
  fontSize?: number;
  fontFamily?: string;
  /** Code font: the face the UA sheet sets code in, which stands for the
   *  generic `monospace` there as a browser's fixed-width font does, at
   *  that generic's smaller size. Default `'monospace'` — there is no theme
   *  token for it. */
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
   * in order to speed up the path it is not.
   *
   * Told what changed — every change since the last `refresh`, shaped as a
   * `MutationObserver` reports them (`HtmlChange`) — it restyles only the
   * elements a selector that tests what changed can reach: a class
   * toggled on a menu restyles the menu and what is in it, and an inline
   * style moving a box positioned out of the flow repaints where it was
   * and is. Without them, every element is styled again, which is always
   * right and costs what a first rendering does.
   */
  refresh(changes?: readonly HtmlChange[]): void;
  /** The element under a point, in the window's coordinates — of the
   *  document as it is now: one changed and `refresh()`ed is laid out
   *  first, as `elementRect` lays it out. */
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
  /**
   * An element's style as `getComputedStyle` reads it, laid out first:
   * the properties a script reads, by name, lengths in CSS pixels and
   * colours as `rgb()`. `pseudo` asks for a `::before` or an `::after`, and
   * is null where no rule gives the element one.
   */
  computedStyle(
    element: Element,
    pseudo?: 'before' | 'after' | null,
  ): Record<string, string> | null;
  /**
   * Whether a media query holds for the document, as `matchMedia` answers:
   * from the same width, viewport height, scale, colour scheme, preference
   * for motion and scripting its own `@media` rules are matched against.
   * False with no document.
   */
  matchMedia(query: string): boolean;
  /**
   * Settled once no style sheet holds back a script the parser met (HTML,
   * "has a style sheet that is blocking scripts"): of the sheets the parse
   * made, those before `script` in the document — or all of them, for a
   * deferred script or a module — each while its `media` holds, a
   * `<link rel=stylesheet>` until its `load` or `error` is told and a
   * `<style>` until what it imports is in. A host runs such a script once
   * this settles, so it reads the document as those sheets style it.
   * Settled at once with no document.
   */
  scriptsUnblocked(script?: Element | null): Promise<void>;
  /**
   * What a form control holds, as a script reads it: what was typed into a
   * field or its markup's value where nothing was, the option a `<select>`
   * shows, whether a checkbox or a radio is checked. Null for what is no
   * control. The `value` attribute is the field's default, and stays as the
   * markup wrote it.
   */
  controlValue(element: Element): string | boolean | null;
  /** Set what a control holds, as a script sets `value` or `checked`: no
   *  event, and a field's widget shows it where it is, its focus kept.
   *  False for what is no control. */
  setControlValue(element: Element, value: string | boolean): boolean;
  /** Give an element the focus, as Tab gives it: a control's widget, a
   *  link, a button, an element with a `tabindex`. False where it takes
   *  none. */
  focus(element: Element): boolean;
  /** Take the focus off whatever of the document's has it. */
  blur(): void;
  /** The document's element whose widget or stop has the focus, or null. */
  readonly activeElement: Element | null;
  /**
   * Run what a click on an element does, with no click told of: follow a
   * link through `onLink`, press a button — a submit button submits, its
   * `submit` asked about first — open or close a `<details>`. A host's
   * `el.click()` calls it once its own click was not cancelled. False
   * where a click does nothing. A checkbox's and a radio's state are
   * `setControlValue`'s.
   */
  activate(element: Element): boolean;
  /** Send a form as `form.submit()` does: no validation, no `submit`. */
  submitForm(form: Element, submitter?: Element | null): void;
  /** HTML's interactive validation of a form: true where it may go, and
   *  else false, with the reason shown at its first wrong control. */
  reportValidity(form: Element, submitter?: Element | null): boolean;
  /** Put a form's controls back as their markup has them, as
   *  `form.reset()` does after its `reset`. */
  resetForm(form: Element): void;
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
    ...(props.defaultColorScheme && { normalScheme: props.defaultColorScheme }),
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
    onViewportOverflow,
    onDomEvent,
    style,
  } = props;

  const theme = useTheme() as unknown as Record<string, unknown>;
  // read whether or not the prop decides, since a hook is called every
  // render or never
  const desktop = useSystemAppearance();
  const reducedMotion = props.reducedMotion ?? desktop.reducedMotion;
  const links = useLinkClicks(onLink);
  const menu = useSelectionMenu(selectable);

  // The element, for the document's base when a form is submitted, as well
  // as wherever the application's `ref` wants it — and the handle's way to
  // what this component holds, the widgets and the focus (`interactive`).
  const viewNode = React.useRef<HtmlViewNode | null>(null);
  const rootNode = React.useRef<DrawnNode | null>(null);
  const live = React.useRef<Live | null>(null);
  const interactive = React.useMemo(
    () => documentInteraction(viewNode, rootNode, live),
    [],
  );
  const outerRef = props.ref;
  const viewRef = React.useCallback(
    (node: HtmlViewNode | null) => {
      viewNode.current = node;
      if (node) node.interactive = interactive;
      if (typeof outerRef === 'function') outerRef(node);
      else if (outerRef) (outerRef as React.RefObject<unknown>).current = node;
    },
    [outerRef, interactive],
  );

  const look = React.useMemo(
    () => deriveLook(theme, props),
    [
      theme,
      props.fontSize,
      props.fontFamily,
      props.monoFamily,
      props.defaultColorScheme,
    ],
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
    onDomEvent,
    touch: () => setDomRevision((n) => n + 1),
  });

  // The keyboard's way through what the document draws: a box that takes
  // the focus for each link, button and summary Tab reaches (`stops.ts`).
  const stops = useFocusStops({
    view: viewNode,
    root: rootNode,
    forms,
    selectable,
    onLink,
    onDomEvent,
  });
  const mayHaveStops = useFocusableMarkup(source);
  // core's `<video>` over each video the document can show one over
  // (`videos.ts`)
  const videos = useVideos(viewNode);
  // what the host shows in the iframes, canvases and embeds (`embedded.ts`)
  const embedded = useEmbedded(props.renderEmbedded);
  live.current = { forms, stops, onLink };
  const events = useDocumentEvents(onDomEvent, viewNode, forms, stops);

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

  // a `<link>`'s sheet applied, or not to be had: told as the page's
  // `load` or `error` at the element, after the fact
  const handleSheet = React.useCallback(
    (element: Element, outcome: 'load' | 'error') =>
      void fireDomEvent(onDomEvent, outcome, element),
    [onDomEvent],
  );

  const selectionColor =
    props.selectionColor ?? tint(String(theme.accent ?? '#2980b9'), 0.35);

  const viewProps: HtmlViewProps & { ref?: React.Ref<unknown> } = {
    source,
    ...(props.document && { document: props.document }),
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
    onMedia: videos.onMedia,
    onEmbedded: props.renderEmbedded ? embedded.onEmbedded : undefined,
    onFocusStops: stops.onFocusStops,
    watchStops: stops.watch,
    onViewportOverflow,
    domRevision,
    animate,
    reducedMotion,
    scripting: props.scripting ?? false,
    onParsed: props.onParsed,
    onLoaded: props.onLoaded,
    onSheet: onDomEvent ? handleSheet : undefined,
    ref: viewRef as React.Ref<unknown>,
    // grown with the component, where an application grows it: the root's
    // background covers the whole of it, as a page's covers the window
    style: { alignSelf: 'stretch', flexGrow: 1 },
  };

  const children: ReactNode[] = [
    h(ELEMENT, { key: 'view', ...viewProps } as Record<string, unknown>),
    // over the document and under its widgets: a video a control is drawn
    // over is no video a player is mounted for
    ...videos.render(),
    ...embedded.render(),
  ];
  // The widgets and the stops in the document's order, which is the order
  // core's Tab goes through a subtree in where the document hands it on:
  // into the document at its first, and out of it after its last.
  const { widgets, message } = forms.render(controls, look);
  const boxes = stops.render();
  let next = 0;
  controls.forEach((rect, i) => {
    const order = stops.orderOf(rect.element) ?? -1;
    while (
      next < boxes.length &&
      (stops.orderOf(boxes[next].element) ?? 0) < order
    ) {
      children.push(boxes[next++].node);
    }
    children.push(widgets[i]);
  });
  while (next < boxes.length) children.push(boxes[next++].node);
  children.push(message);

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
      // Where the document has stops of its own, Tab goes to them and not
      // to the surface they are on, which a press still focuses for the
      // selection's keys — and Tab from there goes on from the press.
      ...(selectable && (stops.hasStops ?? mayHaveStops) && { tabIndex: -1 }),
      ref: rootNode,
      selectionColor: props.selectionColor,
      ...links,
      // what the page hears first, before anything in the document — a
      // widget included — does what it does (`useDocumentEvents`)
      onMouseDownCapture: events.onMouseDownCapture,
      onMouseUpCapture: events.onMouseUpCapture,
      onKeyDownCapture: events.onKeyDownCapture,
      onKeyUpCapture: events.onKeyUpCapture,
      onMouseMoveCapture: events.onMouseMoveCapture,
      onWheelCapture: events.onWheelCapture,
      onMouseDown: (ev: X11MouseEvent<DrawnNode>) => {
        links.onMouseDown(ev);
        forms.onMouseDown(ev);
        stops.onMouseDown(ev);
        // a press on what `user-select: none` keeps out of a selection
        // starts none, and leaves the one there is: turned down here, it
        // never reaches the surface's press, nor its drag
        const view = viewNode.current;
        if (
          selectable &&
          view &&
          ev.target === view &&
          ev.button === 1 &&
          !view.startsSelectionAt(ev.x, ev.y)
        ) {
          ev.preventDefault();
        }
      },
      onKeyDown: stops.onKeyDown,
      onMouseUp: (ev: X11MouseEvent<DrawnNode>) => {
        // the click the press and the release made, which the page may
        // cancel: then no link is followed and no button pressed
        if (!events.clicked(ev)) return;
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
      refresh: (changes?: readonly HtmlChange[]) => {
        nodeRef.current?.touchDocument(changes ?? null);
        force();
      },
      elementAt: (x: number, y: number) =>
        nodeRef.current?.elementAtPoint(x, y) ?? null,
      hrefAt: (x: number, y: number) =>
        nodeRef.current?.hrefAtPoint(x, y) ?? null,
      elementRect: (element: Element) =>
        nodeRef.current?.elementRect(element) ?? null,
      computedStyle: (element: Element, pseudo?: 'before' | 'after' | null) =>
        nodeRef.current?.computedStyle(element, pseudo ?? null) ?? null,
      matchMedia: (query: string) =>
        nodeRef.current?.matchMedia(query) ?? false,
      scriptsUnblocked: (script?: Element | null) =>
        nodeRef.current?.scriptsUnblocked(script ?? null) ?? Promise.resolve(),
      controlValue: (element: Element) =>
        nodeRef.current?.interactive?.controlValue(element) ?? null,
      setControlValue: (element: Element, value: string | boolean) =>
        nodeRef.current?.interactive?.setControlValue(element, value) ?? false,
      focus: (element: Element) =>
        nodeRef.current?.interactive?.focus(element) ?? false,
      blur: () => nodeRef.current?.interactive?.blur(),
      get activeElement() {
        return nodeRef.current?.interactive?.activeElement() ?? null;
      },
      activate: (element: Element) =>
        nodeRef.current?.interactive?.activate(element) ?? false,
      submitForm: (form: Element, submitter?: Element | null) =>
        nodeRef.current?.interactive?.submit(form, submitter ?? null),
      reportValidity: (form: Element, submitter?: Element | null) =>
        nodeRef.current?.interactive?.reportValidity(form, submitter ?? null) ??
        true,
      resetForm: (form: Element) => nodeRef.current?.interactive?.reset(form),
    }),
    [],
  );
}

// --- what happens to the document --------------------------------------------

/** What the handle reaches through `interactive`, as this render has it. */
interface Live {
  forms: ReturnType<typeof useForms>;
  stops: ReturnType<typeof useFocusStops>;
  onLink?: (href: string, ev: X11MouseEvent<DrawnNode>) => void;
}

/** The node core's window has focused, where the element is in a window. */
function focusedNode(view: HtmlViewNode | null): DrawnNode | null {
  // core's node has its window's event manager on its `root`, which its
  // declarations leave out
  const root = (view as unknown as { root?: unknown } | null)?.root as
    { events?: { focused?: DrawnNode | null } } | null | undefined;
  return root?.events?.focused ?? null;
}

/**
 * The element's `interactive`: what the handle asks of the widgets and the
 * focus, through `live`, which every render sets — so one object, made
 * once, answers from the render the handle is called after.
 */
function documentInteraction(
  view: React.RefObject<HtmlViewNode | null>,
  root: React.RefObject<DrawnNode | null>,
  live: React.RefObject<Live | null>,
): DocumentInteraction {
  /** The document's element a node takes the focus for. */
  const owner = (node: DrawnNode | null): Element | null => {
    const now = live.current;
    if (!node || !now) return null;
    return now.forms.controlOf(node) ?? now.stops.elementOf(node);
  };
  return {
    controlValue: (el) => live.current?.forms.value(el) ?? null,
    setControlValue: (el, value) =>
      live.current?.forms.setValue(el, value) ?? false,
    focus: (el) => {
      const now = live.current;
      if (!now) return false;
      return now.forms.focusControl(el) || now.stops.focus(el);
    },
    blur: () => {
      const node = focusedNode(view.current);
      if (node && owner(node)) node.blur();
    },
    activeElement: () => owner(focusedNode(view.current)),
    activate: (el) => {
      const node = view.current;
      const now = live.current;
      if (!node || !now) return false;
      const href = node.hrefOf(el);
      if (href !== null) {
        now.onLink?.(
          href,
          syntheticClick(NO_MODIFIERS, node, root.current, el),
        );
        return true;
      }
      return now.forms.activate(el);
    },
    submit: (form, submitter) => live.current?.forms.submitNow(form, submitter),
    reportValidity: (form, submitter) =>
      live.current?.forms.validate(form, submitter) ?? true,
    reset: (form) => live.current?.forms.resetNow(form),
  };
}

/** The form controls a disabled one hears nothing at: no press reaches
 *  it, as none reaches one in a browser. */
const CONTROLS = new Set(['button', 'input', 'select', 'textarea']);

/** What a press on a control's widget ticks or presses: its click is the
 *  widget's to tell, after the box changes (`widgets.ts`). */
const CLICKS_ITSELF = new Set([
  'checkbox',
  'radio',
  'submit',
  'reset',
  'button',
]);

/**
 * The document's pointer and key events, told to the host before anything
 * else does anything about them: the root's capture phase, which runs
 * before a widget's own handlers. A press's `mousedown`, cancelled, keeps
 * the press from focusing or selecting, as `preventDefault()` keeps it in
 * a browser, and a `keydown` keeps the key from the field it was typed in.
 * The `click` is the press and the release together, on the nearest
 * element both were on (UI Events 3.5), and `clicked` answers whether its
 * default — a link followed, a button pressed — goes on.
 */
function useDocumentEvents(
  onDomEvent: DomEventHandler | undefined,
  view: React.RefObject<HtmlViewNode | null>,
  forms: ReturnType<typeof useForms>,
  stops: ReturnType<typeof useFocusStops>,
) {
  const pressed = React.useRef<Element | null>(null);
  const released = React.useRef<Element | null>(null);
  const fire = (
    type: HtmlDomEventType,
    target: Element,
    init?: DomEventInit,
  ): boolean => fireDomEvent(onDomEvent, type, target, init);

  /** The element a pointer event is on: the control whose widget it is in,
   *  or what the document draws under it. A disabled control hears none. */
  const pointedAt = (ev: X11MouseEvent<DrawnNode>): Element | null => {
    const node = view.current;
    const control = forms.controlOf(ev.target as DrawnNode);
    const at =
      control ??
      (node && ev.target === (node as unknown)
        ? node.elementAtPoint(ev.x, ev.y)
        : null);
    if (at && CONTROLS.has(tagOf(at)) && isDisabled(at)) return null;
    return at;
  };
  const mouse = (ev: X11MouseEvent<DrawnNode>): DomEventInit => ({
    ...documentPoint(ev, view.current?.getClientRects()[0]),
    button: domButton(ev.button),
    ...modifiersOf(ev),
  });
  /** What a key is typed at: a control's widget, a stop's element, or the
   *  document's body where the document itself has the focus. */
  const keyedAt = (target: DrawnNode): Element | null => {
    const node = view.current;
    if (!node) return null;
    const owner = forms.controlOf(target) ?? stops.elementOf(target);
    if (owner) return owner;
    return node.document ? bodyOf(node.document) : null;
  };
  const key =
    (type: 'keydown' | 'keyup') => (ev: X11KeyboardEvent<DrawnNode>) => {
      // a key a composition takes is the composition's, which types its text
      if (!onDomEvent || ev.composing) return;
      const target = keyedAt(ev.target as DrawnNode);
      if (!target) return;
      const names = domKey(ev);
      const go = fire(type, target, {
        key: names.key,
        code: names.code,
        ...modifiersOf(ev),
      });
      if (!go) ev.preventDefault();
    };
  return {
    onMouseDownCapture: (ev: X11MouseEvent<DrawnNode>) => {
      pressed.current = null;
      if (!onDomEvent) return;
      const target = pointedAt(ev);
      if (!target) return;
      pressed.current = target;
      if (!fire('mousedown', target, mouse(ev))) ev.preventDefault();
      // the menu a secondary press asks for, as X11 and macOS ask on the
      // press
      if (ev.button === 3 && !fire('contextmenu', target, mouse(ev))) {
        ev.preventDefault();
      }
    },
    onMouseUpCapture: (ev: X11MouseEvent<DrawnNode>) => {
      released.current = null;
      if (!onDomEvent) return;
      const target = pointedAt(ev);
      if (!target) return;
      released.current = target;
      // nothing to keep from happening: a cancelled release still clicks
      fire('mouseup', target, mouse(ev));
    },
    onKeyDownCapture: key('keydown'),
    onKeyUpCapture: key('keyup'),
    onMouseMoveCapture: (ev: X11MouseEvent<DrawnNode>) => {
      if (!onDomEvent) return;
      const target = pointedAt(ev);
      if (!target) return;
      fire('mousemove', target, {
        ...mouse(ev),
        button: 0,
        buttons: domButtons(ev.nativeEvent?.buttons ?? 0),
      });
    },
    onWheelCapture: (ev: X11WheelEvent<DrawnNode>) => {
      if (!onDomEvent) return;
      const target = pointedAt(ev as unknown as X11MouseEvent<DrawnNode>);
      if (!target) return;
      // a page that takes the wheel for itself keeps the pane from
      // scrolling with it, as a canvas does
      const go = fire('wheel', target, {
        ...documentPoint(ev, view.current?.getClientRects()[0]),
        ...modifiersOf(ev as unknown as Partial<X11MouseEvent<DrawnNode>>),
        deltaX: ev.deltaX,
        deltaY: ev.deltaY,
      });
      if (!go) ev.preventDefault();
    },
    clicked: (ev: X11MouseEvent<DrawnNode>): boolean => {
      const down = pressed.current;
      const up = released.current;
      pressed.current = null;
      released.current = null;
      if (!onDomEvent || ev.button !== 1 || !down || !up) return true;
      const target = sharedAncestor(down, up);
      if (!target) return true;
      // a checkbox's, a radio's and a button's widget tell their own click
      // as they tick or press (`widgets.ts`)
      if (
        tagOf(target) === 'input' &&
        CLICKS_ITSELF.has(inputType(target)) &&
        forms.controlOf(ev.target as DrawnNode)
      ) {
        return true;
      }
      const init = { ...mouse(ev), detail: ev.detail };
      const go = fire('click', target, init);
      if (ev.detail === 2) fire('dblclick', target, init);
      return go;
    },
  };
}

/** The nearest element two are both in, themselves included. */
function sharedAncestor(a: Element, b: Element): Element | null {
  const around = new Set<Element>();
  for (let at: Element | null = a; at; at = flatParentOf(at)) around.add(at);
  for (let at: Element | null = b; at; at = flatParentOf(at)) {
    if (around.has(at)) return at;
  }
  return null;
}

/** The document's `<body>`, or its first element where it has none: what a
 *  key typed with the document itself focused is typed at, as
 *  `document.activeElement` is the body then. */
function bodyOf(doc: Document): Element | null {
  let first: Element | null = null;
  for (const child of doc.children) {
    if (!isElement(child)) continue;
    first ??= child;
    if (tagOf(child) !== 'html') continue;
    for (const inner of child.children) {
      if (isElement(inner) && tagOf(inner) === 'body') return inner;
    }
    return child;
  }
  return first;
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
