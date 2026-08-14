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
import {
  Button,
  Checkbox,
  Radio,
  RadioGroup,
  Select,
  useTheme,
} from 'react-x11';
import type { DrawnNode, MouseEvent as X11MouseEvent } from 'react-x11';
import { tint } from 'react-x11/style';
import type { Style } from 'react-x11/style';

import type {} from 'react-x11/jsx-runtime';

import { useLinkClicks, useSelectionMenu } from '../richtext/index.js';
import { hx } from './hx.js';
import { attr } from './dom.js';
import type { Document, Element } from './dom.js';
import { ELEMENT, HtmlViewNode, registerHtmlView } from './node.js';
import type { HtmlViewProps, ScriptRequest } from './node.js';
import type { RootLook } from './css/style.js';
import {
  buttonLabel,
  optionsOf,
  selectedOption,
  textareaValue,
} from './controls.js';
import type { ControlRect } from './controls.js';
import type { ResourceRequest, ResourceResult } from './resources.js';

export {
  ELEMENT as HTMLVIEW_ELEMENT,
  HtmlViewNode,
  registerHtmlView,
} from './node.js';
export type { HtmlViewProps, ScriptRequest } from './node.js';
export type { ResourceRequest, ResourceResult } from './resources.js';
export type { ControlRect } from './controls.js';
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
   */
  partial?: boolean;
  /** Mouse selection, Ctrl+A / Ctrl+C, PRIMARY. Default true. */
  selectable?: boolean;
  /** Extra author stylesheets, applied after the document's own. */
  stylesheet?: string | string[];
  /**
   * An external resource is wanted — an `<img src>`, a `<link rel=stylesheet>`
   * or an `@import`. Return the bytes or the text, or a promise of them, or
   * `null` to decline.
   *
   * **Absent, nothing loads.** This component has no network and no
   * filesystem of its own; images render as a frame and linked stylesheets
   * are skipped. The host is the one that knows its cache, its proxy and
   * whether this document is trusted.
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
   * never navigates by itself.
   */
  onLink?: (href: string, ev: X11MouseEvent<DrawnNode>) => void;
  /** The parsed document, each time it is re-parsed — the DOM handle. */
  onDocument?: (document: Document) => void;
  /**
   * A form control changed. The element is the one in the DOM, so a handler
   * that wants to keep the value writes it back with `setAttribute`-shaped
   * mutation and calls the handle's `refresh()`.
   */
  onControlChange?: (element: Element, value: string | boolean) => void;
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
  /** The document's `<title>`, if it had one. */
  readonly title: string | null;
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
    surface: String(theme.surface ?? theme.background ?? 'white'),
    controlPadY: Number(theme.paddingY ?? 6),
    controlBorder: Number(theme.borderWidth ?? 1),
    controlRadius: Number(theme.radius ?? 4),
  };
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
    stylesheet,
    onLink,
    onResource,
    onScript,
    onDocument,
    onControlChange,
    style,
  } = props;

  const theme = useTheme() as unknown as Record<string, unknown>;
  const links = useLinkClicks(onLink);
  const menu = useSelectionMenu(selectable);

  const look = React.useMemo(
    () => deriveLook(theme, props),
    [theme, props.fontSize, props.fontFamily, props.monoFamily],
  );

  const documentRef = React.useRef<Document | null>(null);
  const [controls, setControls] = React.useState<ControlRect[]>([]);
  const [domRevision, setDomRevision] = React.useState(0);

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
    look,
    selectionColor,
    onResource,
    onScript,
    onDocument: handleDocument,
    onControls: handleControls,
    domRevision,
    ref: props.ref as React.Ref<unknown>,
    style: { alignSelf: 'stretch' },
  };

  const children: ReactNode[] = [
    h(ELEMENT, { key: 'view', ...viewProps } as Record<string, unknown>),
  ];
  for (const rect of controls) {
    children.push(
      renderControl(
        rect,
        look,
        () => setDomRevision((n) => n + 1),
        onControlChange,
      ),
    );
  }

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
      refresh: () => {
        nodeRef.current?.touchDocument();
        force();
      },
      elementAt: (x: number, y: number) =>
        nodeRef.current?.elementAtPoint(x, y) ?? null,
    }),
    [],
  );
}

// --- the widgets ------------------------------------------------------------

/**
 * One form control, as a real widget at the rectangle layout reserved for it.
 *
 * Every one of these is a **core** widget rather than something drawn here:
 * a `<select>` in a document drops the same menu as a `<Select>` in the
 * window around it, a `<textinput>` gets the same caret, the same IME and the
 * same edit menu, and all of them join the window's focus order. The
 * alternative — drawing them in the paint pass — would be a picture of a form.
 */
function renderControl(
  rect: ControlRect,
  look: RootLook,
  touch: () => void,
  onChange: HtmlProps['onControlChange'],
): ReactNode {
  const el = rect.element;
  const key = `${rect.kind}:${rect.x},${rect.y}`;
  const disabled = attr(el, 'disabled') !== undefined;
  const readOnly = attr(el, 'readonly') !== undefined;
  const frame: Style = {
    position: 'absolute',
    left: Math.round(rect.x),
    top: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  const report = (value: string | boolean): void => {
    onChange?.(el, value);
    touch();
  };
  // A text edit does NOT touch: the value lives in the widget and is echoed
  // into the DOM attribute, and neither changes any box — while `touch()`
  // would re-run the cascade and relayout the whole document *per
  // keystroke*. This also matches HTML's own semantics: typing updates the
  // value property, not the attribute selectors match against. The
  // checkables keep the full touch, because `[checked]` is a selector
  // documents really use.
  const reportText = (value: string): void => {
    onChange?.(el, value);
  };

  let widget: ReactNode;
  switch (rect.kind) {
    case 'checkbox':
      widget = h(Checkbox, {
        checked: attr(el, 'checked') !== undefined,
        disabled,
        onChange: (ev) => {
          const next = ev.value;
          if (next) el.attribs.checked = '';
          else delete el.attribs.checked;
          report(next);
        },
      });
      break;
    case 'radio': {
      // Core's radio is a group member and HTML's is a free-standing input
      // that happens to share a `name`. Each one is therefore its own
      // one-member `RadioGroup`, and the exclusivity that makes it a group
      // is done where HTML actually keeps it: in the DOM.
      const value = attr(el, 'value') ?? 'on';
      widget = h(
        RadioGroup,
        {
          value: attr(el, 'checked') !== undefined ? value : undefined,
          onChange: () => {
            clearRadioGroup(el);
            el.attribs.checked = '';
            report(value);
          },
        },
        h(Radio, { key: 'r', value, disabled }),
      );
      break;
    }
    case 'button':
      widget = h(Button, {
        label: buttonLabel(el),
        disabled,
        style: { width: '100%', height: '100%' },
        onPress: () => report(attr(el, 'value') ?? ''),
      });
      break;
    case 'select': {
      const options = optionsOf(el);
      widget = h(Select, {
        options: options.map((o) => ({ value: o.value, label: o.label })),
        value: selectedOption(el) ?? undefined,
        disabled,
        style: { width: '100%', height: '100%' },
        onChange: (ev) => {
          const next = String(ev.value ?? '');
          setSelectedOption(el, next);
          report(next);
        },
      });
      break;
    }
    case 'textarea':
      // Uncontrolled on purpose: the widget owns the live text the way a
      // browser's does, and a re-render from any other cause remounts it
      // with whatever was last echoed into the DOM.
      widget = hx('textarea', {
        defaultValue: textareaValue(el),
        style: [fieldChrome(look), { width: '100%', height: '100%' }],
        onChange: readOnly ? undefined : (ev) => reportText(ev.value),
      });
      break;
    case 'input': {
      const type = (attr(el, 'type') ?? 'text').toLowerCase();
      widget = hx('textinput', {
        defaultValue: attr(el, 'value') ?? '',
        placeholder: attr(el, 'placeholder'),
        // Core's word for a password field: nothing in it reaches a
        // selection, PRIMARY included.
        sensitive: type === 'password',
        style: [fieldChrome(look), { width: '100%', height: '100%' }],
        onChange: readOnly
          ? undefined
          : (ev) => {
              el.attribs.value = ev.value;
              reportText(ev.value);
            },
      });
      break;
    }
    default:
      return null;
  }
  return hx('box', { key, style: frame, selectable: false }, widget);
}

/**
 * The chrome a text field needs.
 *
 * `<textinput>` and `<textarea>` are core *elements* rather than components,
 * so they draw no frame of their own — an application supplies one, which is
 * why core's own `<Button>` and `<Select>` are components and these are not.
 * The values are the palette's, so a field in a document and a `<Select>`
 * beside it are the same height with the same corner and the same edge.
 */
function fieldChrome(look: RootLook): Style {
  return {
    backgroundColor: look.surface,
    borderWidth: look.controlBorder,
    borderColor: look.borderColor,
    borderRadius: look.controlRadius,
    paddingLeft: 6,
    paddingRight: 6,
    color: look.color,
    fontFamily: look.fontFamily,
    fontSize: look.fontSize,
  };
}

function clearRadioGroup(el: Element): void {
  const name = attr(el, 'name');
  if (!name) return;
  let root: Element | null = el;
  while (root?.parent && root.parent.type === 'tag')
    root = root.parent as Element;
  if (!root) return;
  const walk = (node: Element): void => {
    for (const child of node.children) {
      if (child.type !== 'tag') continue;
      const tag = child.name.toLowerCase();
      if (
        tag === 'input' &&
        (child.attribs.type ?? '').toLowerCase() === 'radio' &&
        child.attribs.name === name
      ) {
        delete child.attribs.checked;
      }
      walk(child);
    }
  };
  walk(root);
}

function setSelectedOption(el: Element, value: string): void {
  const walk = (node: Element): void => {
    for (const child of node.children) {
      if (child.type !== 'tag') continue;
      if (child.name.toLowerCase() === 'option') {
        let label = '';
        for (const kid of child.children) {
          if (kid.type === 'text') label += kid.data;
        }
        const own = child.attribs.value ?? label.trim();
        if (own === value) child.attribs.selected = '';
        else delete child.attribs.selected;
      }
      walk(child);
    }
  };
  walk(el);
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
