// The form controls' React half: the widgets mounted at the rectangles
// layout reserved for them, what a press on a `<button>`, a `<label>` or an
// image button does, and a form's submission — checked, encoded, and handed
// to `onSubmit`.
//
// Every widget here is a **core** one rather than something drawn: a
// `<select>` in a document drops the same menu as a `<Select>` in the window
// around it, a `<textinput>` gets the same caret, the same IME and the same
// edit menu, and all of them join the window's focus order. What the
// document draws itself is a `<button>`, whose content is the page's, and an
// image button, which is a picture; a press on either reaches the element,
// which is why this also watches the document's own presses — a summary's
// too, which opens its details.
//
// What the markup cannot say — what was typed, what a reset puts back — is
// `FormState`'s (form.ts), one per `<Html>`, and what a submission carries
// and where it goes is form.ts's too. This is the half that has a React
// tree.
import React from 'react';
import type { ReactNode } from 'react';
import {
  Button,
  Checkbox,
  Radio,
  RadioGroup,
  Select,
  ThemeProvider,
} from 'react-x11';
import type {
  DrawnNode,
  TextInputNode,
  Theme,
  MouseEvent as X11MouseEvent,
} from 'react-x11';
import type { Style } from 'react-x11/style';

import type {} from 'react-x11/jsx-runtime';

import { cancelLater, later } from '../internal/timers.js';
import { hx } from './hx.js';
import { attr, isElement, tagOf } from './dom.js';
import type { Document, Element } from './dom.js';
import type { HtmlViewNode } from './node.js';
import { browserSystemColor } from './css/color.js';
import type { RootLook } from './css/style.js';
import { between, buttonLabel, optionsOf, selectedOption } from './controls.js';
import type { BareField, ControlRect } from './controls.js';
import {
  FormState,
  buttonType,
  controlsOf,
  firstInvalid,
  formOwner,
  formSubmission,
  implicitSubmission,
  inputType,
  isDisabled,
  labeledControl,
  optionElements,
  optionValue,
  radioGroup,
} from './form.js';
import type { FormSubmission } from './form.js';
import { isSummaryOf, tabIndexOf } from './focus.js';

const h = React.createElement;

/** A point in CSS pixels, from an element's top left. */
type Point = { x: number; y: number };

export interface FormsOptions {
  /** The element, for the document's base, its geometry and its window. */
  view: React.RefObject<HtmlViewNode | null>;
  /** The URL the document came from: an empty `action` is it. */
  baseUrl: string | null | undefined;
  onControlChange?: (element: Element, value: string | boolean) => void;
  onSubmit?: (submission: FormSubmission) => void;
  /** Restyle and lay out again: a change a selector can see. */
  touch: () => void;
}

export interface Forms {
  /** The document's own presses: its `<button>`s, `<label>`s, image
   *  buttons and summaries. */
  onMouseDown: (ev: X11MouseEvent<DrawnNode>) => void;
  onMouseUp: (ev: X11MouseEvent<DrawnNode>) => void;
  /** The widgets for the rectangles layout reported, each at its rect's
   *  index — null where a rect has none — and the message of a form that
   *  would not submit. */
  render(
    rects: readonly ControlRect[],
    look: RootLook,
  ): { widgets: ReactNode[]; message: ReactNode };
  /** Give a control's widget the focus; false where it has none mounted. */
  focusControl(el: Element): boolean;
  /** The control whose widget `node` is, or is in, or null. */
  controlOf(node: DrawnNode | null): Element | null;
  /** Something the document draws, activated from the keyboard: a
   *  `<button>` or an image button pressed, a summary's details opened or
   *  closed. False where it does nothing. */
  activate(el: Element): boolean;
  /**
   * Something of the document's took the focus, or gave it up: the element
   * it is the document's `:focus` (`HtmlViewNode.setFocus`). A blur is
   * told a microtask later, so that a move from one to the next is one
   * change to the document.
   */
  focused(el: Element, on: boolean): void;
}

/** How far a press may travel and still be a click — `useLinkClicks`'s
 *  rule, so a link and a button in one document agree about it. */
const CLICK_SLOP = 4;

/** How long a validation message stays, as a browser's bubble does. */
const MESSAGE_MS = 5000;

export function useForms(options: FormsOptions): Forms {
  const { view, baseUrl, onControlChange, onSubmit, touch } = options;

  // What the controls hold that the markup does not, for the widgets'
  // next mount, a submission and a reset.
  const forms = React.useMemo(() => new FormState(), []);
  const live = (el: Element) => forms.typed(el);
  const [invalid, setInvalid] = React.useState<{
    element: Element;
    message: string;
  } | null>(null);

  // Each element's widget is keyed by the element, not by where it is: a
  // field that layout moves — a stylesheet arriving, an image above it
  // loading, a resize — is the same widget, and keeps its focus, its caret
  // and its undo. Keyed by position, each move mounted a new one, and a
  // page whose stylesheet landed while someone was typing lost the field
  // from under them. Nor by how many resets there have been: see `press`.
  const widgets = React.useMemo(
    () =>
      new WidgetBoxes((el) => {
        // a field that unmounts with the focus is forgotten rather than
        // blurred, and the document is told it went
        const node = view.current;
        if (node?.focusedElement === el) node.setFocus(null);
      }),
    [view],
  );

  // Which element's field holds the focus, for `:focus` and its kin
  // (`HtmlViewNode.setFocus`). A blur is told a microtask later, and only
  // where no field took the focus in the meantime: core blurs one field
  // and then focuses the next, and a move from one to the other is one
  // change to the document, not two.
  const blurred = React.useRef<Element | null>(null);
  const focused = (el: Element, on: boolean) => {
    if (on) {
      blurred.current = null;
      view.current?.setFocus(el, true);
      return;
    }
    blurred.current = el;
    void Promise.resolve().then(() => {
      if (blurred.current !== el) return;
      blurred.current = null;
      const node = view.current;
      if (node?.focusedElement === el) node.setFocus(null);
    });
  };

  React.useEffect(() => {
    if (!invalid) return;
    const timer = later(() => setInvalid(null), MESSAGE_MS);
    return () => cancelLater(timer);
  }, [invalid]);

  const submit = (form: Element, submitter: Element | null, point?: Point) => {
    if (!onSubmit) return;
    // a form that would send what its own constraints refuse says why, at
    // the first control that is wrong, and sends nothing
    const wrong = firstInvalid(form, submitter, live);
    if (wrong) {
      setInvalid(wrong);
      widgets.focus(wrong.element);
      return;
    }
    setInvalid(null);
    const node = view.current;
    const submission = formSubmission(form, submitter, {
      base: node?.documentBase ?? baseUrl ?? null,
      documentUrl: baseUrl ?? null,
      live,
      point,
    });
    if (submission) onSubmit(submission);
  };

  /** A button's activation behaviour (HTML 4.10.6): a submit button
   *  submits its form, a reset button resets it, and any other does
   *  nothing. Reported first, as a pressed widget is. */
  const press = (button: Element, point?: Point) => {
    onControlChange?.(button, attr(button, 'value') ?? '');
    const kind = buttonType(button);
    const form = kind && kind !== 'button' ? formOwner(button) : null;
    if (!form) return;
    if (kind === 'submit') submit(form, button, point);
    else if (forms.reset(form)) {
      setInvalid(null);
      // A field's text is its widget's, which the markup only starts it
      // with, so a reset sets it in place, as a browser's sets each field's
      // value; the rest follow the attributes the reset put back. Mounting
      // the widgets again instead, by a count of resets in every key, took
      // the focus from the button pressed, and the caret, the scroll and the
      // undo from every field in the document, other forms' included.
      for (const el of controlsOf(form)) {
        const field = widgets.fieldOf(el);
        if (field) field.value = forms.value(el);
      }
      touch();
    }
  };

  /** A control's value changed: tell the application, and let a message
   *  about it go. */
  const changed = (el: Element, value: string | boolean, restyle: boolean) => {
    onControlChange?.(el, value);
    // a field's change lets its own message go, and a radio's its group's
    if (
      invalid &&
      (invalid.element === el ||
        (tagOf(el) === 'input' &&
          inputType(el) === 'radio' &&
          radioGroup(el).includes(invalid.element)))
    ) {
      setInvalid(null);
    }
    if (restyle) touch();
  };

  const setChecked = (el: Element, checked: boolean) => {
    forms.remember(el);
    if (checked) el.attribs.checked = '';
    else delete el.attribs.checked;
    changed(el, checked, true);
  };

  // Core's radio is a group member and HTML's is a free-standing input that
  // happens to share a `name`. Each one is therefore its own one-member
  // `RadioGroup`, and the exclusivity that makes it a group is done where
  // HTML keeps it: in the DOM, across the radios of its name in its form.
  const checkRadio = (el: Element) => {
    for (const other of radioGroup(el)) {
      if (attr(other, 'checked') === undefined) continue;
      forms.remember(other);
      delete other.attribs.checked;
    }
    forms.remember(el);
    el.attribs.checked = '';
    changed(el, attr(el, 'value') ?? 'on', true);
  };

  /** A summary's activation behaviour (HTML 4.11.2): its details open, or
   *  close. The attribute is the state, as `checked` is a checkbox's, and
   *  `details[open]` a selector a sheet styles by. */
  const toggleDetails = (summary: Element) => {
    const details = summary.parent as Element;
    if (attr(details, 'open') !== undefined) delete details.attribs.open;
    else details.attribs.open = '';
    touch();
  };

  /** A press on a `<label>` is one on its control (HTML 4.10.4): a box is
   *  toggled, a radio checked, a button pressed, and a field focused. */
  const activateLabel = (control: Element) => {
    if (isDisabled(control)) return;
    const tag = tagOf(control);
    const type = tag === 'input' ? inputType(control) : '';
    if (type === 'checkbox') {
      setChecked(control, attr(control, 'checked') === undefined);
    } else if (type === 'radio') {
      if (attr(control, 'checked') === undefined) checkRadio(control);
    } else if (tag === 'button' || buttonType(control) !== null) {
      press(control, type === 'image' ? { x: 0, y: 0 } : undefined);
    } else {
      widgets.focus(control);
    }
  };

  // The document's own presses. A press and a release on the same thing,
  // close together: a click, not a drag.
  const pressed = React.useRef<{ at: Pressable; x: number; y: number } | null>(
    null,
  );
  const onMouseDown = (ev: X11MouseEvent<DrawnNode>) => {
    pressed.current = null;
    if (ev.button !== 1) return;
    const at = pressableAt(ev);
    if (at) pressed.current = { at, x: ev.x, y: ev.y };
  };
  const onMouseUp = (ev: X11MouseEvent<DrawnNode>) => {
    const start = pressed.current;
    pressed.current = null;
    if (!start || ev.button !== 1) return;
    if (
      Math.abs(ev.x - start.x) > CLICK_SLOP ||
      Math.abs(ev.y - start.y) > CLICK_SLOP
    ) {
      return;
    }
    const at = pressableAt(ev);
    if (!at || at.element !== start.at.element) return;
    if (at.kind === 'label') {
      // a label is text, and a drag that selected some of it was reading
      // it; a button is pressed however many times it is clicked
      if (!(ev.currentTarget?.textSelection?.isCollapsed ?? true)) return;
      activateLabel(at.control);
    } else if (at.kind === 'summary') {
      // its text, as a label's is, and read the same way
      if (!(ev.currentTarget?.textSelection?.isCollapsed ?? true)) return;
      toggleDetails(at.element);
    } else if (at.kind === 'image')
      press(at.element, imagePoint(at.element, ev));
    else press(at.element);
  };

  /** Where in an image button a press landed, in its own CSS pixels. */
  const imagePoint = (el: Element, ev: X11MouseEvent<DrawnNode>): Point => {
    const node = view.current;
    const rect = node?.elementRect(el);
    const origin = node?.getClientRects()[0];
    if (!rect || !origin) return { x: 0, y: 0 };
    return {
      x: Math.max(0, ev.x - origin.x - rect.x),
      y: Math.max(0, ev.y - origin.y - rect.y),
    };
  };

  // `autofocus`: the first control that asks for the focus gets it once a
  // document is up — where nothing else in the window holds it. A page
  // never takes the keyboard from the application around it.
  const autofocused = React.useRef<Document | null>(null);
  const autofocus = (rects: readonly ControlRect[]) => {
    const document = view.current?.document ?? null;
    if (!document || autofocused.current === document) return;
    const wants = rects.find((r) => attr(r.element, 'autofocus') !== undefined);
    if (!wants) return;
    autofocused.current = document;
    let top: DrawnNode | null = view.current as unknown as DrawnNode;
    while (top?.parent) top = top.parent as DrawnNode;
    if (top?.focusWithin) return;
    widgets.focus(wants.element);
  };

  const ctx: ControlContext = {
    forms,
    widgets,
    changed,
    setChecked,
    checkRadio,
    press,
    focused,
    submitFrom: (field) => {
      const plan = implicitSubmission(field);
      if (plan) submit(plan.form, plan.submitter);
    },
  };

  const rendered = React.useRef<readonly ControlRect[]>([]);
  React.useEffect(() => autofocus(rendered.current));

  return {
    onMouseDown,
    onMouseUp,
    render: (rects, look) => {
      rendered.current = rects;
      return {
        widgets: rects.map((rect) => renderControl(rect, look, ctx)),
        message: invalid
          ? renderMessage(invalid, rects, view.current, look)
          : null,
      };
    },
    focusControl: (el) => widgets.focus(el),
    controlOf: (node) => widgets.elementOf(node),
    activate: (el) => {
      const tag = tagOf(el);
      if (tag === 'summary') {
        toggleDetails(el);
        return true;
      }
      if (isDisabled(el)) return false;
      if (tag === 'button') {
        press(el);
        return true;
      }
      if (tag === 'input' && inputType(el) === 'image') {
        // from the keyboard, as a browser's: at the image's corner
        press(el, { x: 0, y: 0 });
        return true;
      }
      return false;
    },
    focused,
  };
}

/** What a press in the document can be a press of. */
type Pressable =
  | { kind: 'button'; element: Element }
  | { kind: 'image'; element: Element }
  | { kind: 'summary'; element: Element }
  | { kind: 'label'; element: Element; control: Element };

/**
 * The thing a press lands on: the nearest `<button>`, image button,
 * `<label>` or details' summary around the element under it. A link inside
 * one is the link's, and a disabled button is pressed by nobody; a label
 * with nothing to label is only text.
 */
function pressableAt(ev: X11MouseEvent<DrawnNode>): Pressable | null {
  const target = ev.target as {
    elementAtPoint?: (x: number, y: number) => Element | null;
  } | null;
  let node =
    typeof target?.elementAtPoint === 'function'
      ? target.elementAtPoint(ev.x, ev.y)
      : null;
  for (
    ;
    node;
    node = node.parent?.type === 'tag' ? (node.parent as Element) : null
  ) {
    const tag = tagOf(node);
    if (tag === 'a' && attr(node, 'href') !== undefined) return null;
    if (tag === 'button') {
      return isDisabled(node) ? null : { kind: 'button', element: node };
    }
    if (tag === 'input' && inputType(node) === 'image') {
      return isDisabled(node) ? null : { kind: 'image', element: node };
    }
    if (tag === 'label') {
      const control = labeledControl(node);
      return control ? { kind: 'label', element: node, control } : null;
    }
    if (tag === 'summary' && isSummaryOf(node)) {
      return { kind: 'summary', element: node };
    }
  }
  return null;
}

/**
 * The box each element's widget is mounted in, by element: the key the
 * widget is mounted under, and where to find it to give it the focus.
 */
class WidgetBoxes {
  private _ids = new WeakMap<Element, number>();
  private _next = 0;
  private _boxes = new Map<Element, DrawnNode>();
  private _elements = new WeakMap<DrawnNode, Element>();
  private _refs = new WeakMap<Element, (node: DrawnNode | null) => void>();

  /** `gone` hears of each element whose widget's box unmounted. */
  constructor(private readonly _gone: (el: Element) => void) {}

  idOf(el: Element): number {
    let id = this._ids.get(el);
    if (id === undefined) this._ids.set(el, (id = ++this._next));
    return id;
  }

  /** A ref for the box of `el`'s widget, the same one every render. */
  refOf(el: Element): (node: DrawnNode | null) => void {
    let ref = this._refs.get(el);
    if (!ref) {
      ref = (node) => {
        if (node) {
          this._boxes.set(el, node);
          this._elements.set(node, el);
        } else if (this._boxes.get(el)) {
          this._boxes.delete(el);
          this._gone(el);
        }
      };
      this._refs.set(el, ref);
    }
    return ref;
  }

  /** The element whose widget's box `node` is, or is inside. */
  elementOf(node: DrawnNode | null): Element | null {
    for (let at = node; at; at = at.parent as DrawnNode | null) {
      const el = this._elements.get(at);
      if (el) return this._boxes.get(el) === at ? el : null;
    }
    return null;
  }

  /** The text field `el`'s widget is, where it is one and is mounted: the
   *  `<textinput>` or `<textarea>` in its box. */
  fieldOf(el: Element): TextInputNode | null {
    const box = this._boxes.get(el);
    const stack: DrawnNode[] = box ? [box] : [];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.kind === 'textinput' || node.kind === 'textarea') {
        return node as TextInputNode;
      }
      stack.push(...(node.children as DrawnNode[]));
    }
    return null;
  }

  /** Focus `el`'s widget: the first node in its box that takes the focus. */
  focus(el: Element): boolean {
    const box = this._boxes.get(el);
    if (!box) return false;
    const stack: DrawnNode[] = [box];
    while (stack.length) {
      const node = stack.shift()!;
      if (takesFocus(node)) {
        node.focus();
        return true;
      }
      stack.unshift(...(node.children as DrawnNode[]));
    }
    return false;
  }
}

/**
 * Whether a node takes the focus: core's rule, which it keeps to itself
 * (`isFocusable` in its a11y.js) — `focusable` or a `tabIndex` where the
 * props say, and else the element's own default (a `<textinput>`'s) or a
 * selectable surface, and never when disabled. `focus()` itself focuses
 * any node it is asked to, the box a widget sits in included.
 */
function takesFocus(node: DrawnNode): boolean {
  const { props, focusableByDefault } = node as unknown as {
    props: Record<string, unknown>;
    focusableByDefault?: boolean;
  };
  if (props.disabled) return false;
  if (typeof props.focusable === 'boolean') return props.focusable;
  if (props.tabIndex != null) return true;
  return (focusableByDefault ?? false) || props.selectable === true;
}

// --- the widgets ------------------------------------------------------------

/** What every mounted control shares: the live state, and what to do when
 *  one changes or is pressed. */
interface ControlContext {
  forms: FormState;
  widgets: WidgetBoxes;
  changed: (el: Element, value: string | boolean, restyle: boolean) => void;
  setChecked: (el: Element, checked: boolean) => void;
  checkRadio: (el: Element) => void;
  /** A button was pressed: what it does to its form. */
  press: (button: Element) => void;
  /** A field's widget took the focus, or gave it up. */
  focused: (el: Element, on: boolean) => void;
  /** Enter in a text field: its form's implicit submission. */
  submitFrom: (field: Element) => void;
}

/** One form control, as a real widget at the rectangle layout reserved for
 *  it. */
function renderControl(
  rect: ControlRect,
  look: RootLook,
  ctx: ControlContext,
): ReactNode {
  const { forms } = ctx;
  const el = rect.element;
  const key = `${rect.kind}:${ctx.widgets.idOf(el)}`;
  const disabled = isDisabled(el);
  const readOnly = attr(el, 'readonly') !== undefined;
  // a field whose box the document draws takes its content box
  const at = rect.bare ?? rect;
  const left = Math.round(at.x);
  const top = Math.round(at.y);
  const width = Math.round(at.width);
  const height = Math.round(at.height);
  // What the widget shows through: its own rectangle, or where the
  // document cuts the element, what the cut leaves of it — out to where a
  // focus ring reaches, which a clip around the element cuts as it cuts
  // the element, and one that leaves the box whole does not.
  const port = rect.clip
    ? between(rect.clip, {
        x: left - RING_REACH,
        y: top - RING_REACH,
        width: width + 2 * RING_REACH,
        height: height + 2 * RING_REACH,
      })
    : { x: left, y: top, width, height };
  const frame: Style = {
    position: 'absolute',
    left: left - port.x,
    top: top - port.y,
    width,
    height,
    // The face and the size the box was measured in, the element's: the
    // palette's from the UA sheet, or the page's where it set its own. A
    // field inherits them, and so does a `<Button>`'s or a `<Select>`'s
    // caption — named here because the text cascade takes the palette's
    // from the window, and a provider inside it that names a face or a size
    // reaches `useTheme` and not the cascade.
    fontFamily: rect.fontFamily,
    fontSize: rect.fontSize,
    // core's `opacity` is CSS's: the widget faded as a group, and at 0 not
    // drawn and still hit
    ...(rect.opacity !== undefined && { opacity: rect.opacity }),
  };
  // The scheme the control is drawn in, where it is not the palette's: a
  // browser's control in that scheme, as the page around it is a
  // browser's page in it (`BROWSER_CONTROLS`).
  const browser =
    rect.colorScheme && rect.colorScheme !== look.colorScheme
      ? rect.colorScheme
      : null;
  const field = rect.bare ? bareField(rect.bare) : fieldChrome(look, browser);
  const order = tabOrder(el);
  // A button or a select whose font the page set is the drawn control: a
  // native bezel sets its title at AppKit's size, whatever it is handed,
  // in a bezel only as tall as that title, where the box was measured for
  // the page's.
  const ownFont = !paletteFont(rect, look);
  // A text edit does NOT restyle: the value lives in the widget and in
  // `forms`, and neither changes any box — while a restyle would re-run
  // the cascade and relayout the whole document *per keystroke*. This also
  // matches HTML's own semantics: typing updates the value, not the
  // attribute selectors match against. The checkables do restyle, because
  // `:checked` is a selector documents really use.
  const typed = (value: string) => {
    forms.setTyped(el, value);
    ctx.changed(el, value, false);
  };

  let widget: ReactNode;
  switch (rect.kind) {
    case 'checkbox':
      widget = h(Checkbox, {
        checked: attr(el, 'checked') !== undefined,
        disabled,
        ...order,
        // the element's whole box takes the press, as it does in a browser:
        // a page that sizes one over its label, invisible, means the label
        style: { width: '100%', height: '100%' },
        onChange: (ev) => ctx.setChecked(el, ev.value),
      });
      break;
    case 'radio': {
      const value = attr(el, 'value') ?? 'on';
      // No `tabindex` reaches a radio: core's `<Radio>` takes no props for
      // the node it draws, as the other widgets do, and the group's box is
      // not the one that takes the focus.
      widget = h(
        RadioGroup,
        {
          value: attr(el, 'checked') !== undefined ? value : undefined,
          onChange: () => ctx.checkRadio(el),
        },
        h(Radio, { key: 'r', value, disabled }),
      );
      break;
    }
    case 'button':
      widget = h(Button, {
        label: buttonLabel(el),
        disabled,
        ...order,
        ...(ownFont && { native: false }),
        style: { width: '100%', height: '100%' },
        onPress: () => ctx.press(el),
      });
      break;
    case 'select': {
      const options = optionsOf(el);
      widget = h(Select, {
        options: options.map((o) => ({ value: o.value, label: o.label })),
        value: selectedOption(el) ?? undefined,
        // a `<select>` with nothing selected has no options, and shows
        // none: core's "Select…" is an application's prompt, not a page's
        placeholder: '',
        // The platform's own menu, where the backend drops one (macOS), for
        // every select, styled or not: a page restyles a select's box, and
        // its list is still the menu Safari and Chrome drop there. Core's
        // default would keep a drawn menu under the drawn trigger a styled
        // select gets.
        nativeMenu: true,
        disabled,
        ...order,
        style: rect.bare
          ? [BARE_TRIGGER, { width: '100%', height: '100%' }]
          : { width: '100%', height: '100%' },
        // the slots choose the drawn trigger on every backend, and put the
        // caption and the arrow in the page's ink
        ...(rect.bare && {
          labelStyle: {
            color: rect.bare.color,
            fontFamily: rect.fontFamily,
            fontSize: rect.fontSize,
          },
          chevronStyle: rect.bare.chevron
            ? { color: rect.bare.color }
            : { display: 'none' },
        }),
        // and so does a caption in the page's font, whose size the chevron
        // is read back from: it is as tall as the capitals beside it
        ...(!rect.bare &&
          ownFont && {
            labelStyle: {
              fontFamily: rect.fontFamily,
              fontSize: rect.fontSize,
            },
          }),
        onChange: (ev) => {
          const next = String(ev.value ?? '');
          forms.remember(el);
          setSelectedOption(el, next);
          ctx.changed(el, next, true);
        },
      });
      break;
    }
    case 'textarea':
      // Uncontrolled on purpose: the widget owns the live text the way a
      // browser's does, and one mounted again — its element hidden and
      // shown — starts from what `forms` kept of it. A reset sets the text
      // of the one mounted (`press`).
      widget = hx('textarea', {
        defaultValue: forms.value(el),
        // a text area's hint keeps its line breaks (HTML 4.10.11)
        placeholder: attr(el, 'placeholder')?.replace(/\r\n?/g, '\n'),
        placeholderColor: rect.placeholderColor,
        maxLength: maxLength(el),
        ...order,
        style: [field, FIELD_BOX],
        onChange: readOnly ? undefined : (ev) => typed(ev.value),
        onFocus: () => ctx.focused(el, true),
        onBlur: () => ctx.focused(el, false),
      });
      break;
    case 'input': {
      const type = inputType(el);
      widget = hx('textinput', {
        defaultValue: forms.value(el),
        // a field's hint is one line, its breaks taken out (HTML
        // 4.10.5.3.10)
        placeholder: attr(el, 'placeholder')?.replace(/[\r\n]/g, ''),
        placeholderColor: rect.placeholderColor,
        maxLength: maxLength(el),
        ...order,
        // Core's word for a password field: nothing in it reaches a
        // selection, PRIMARY included.
        sensitive: type === 'password',
        // a browser's caret is the field's text colour (`caret-color:
        // auto`), which is the page's where the page drew the field — the
        // palette's own field keeps the palette's caret
        ...(rect.bare && { caretColor: rect.bare.color }),
        style: [field, FIELD_BOX],
        onChange: readOnly
          ? undefined
          : (ev) => {
              typed(ev.value);
              // echoed where it always was, for a handler that reads it
              // back off the element — after `typed`, which keeps what the
              // attribute said before for a reset
              el.attribs.value = ev.value;
            },
        // Enter submits the field's form, as it does in a browser
        onSubmit: () => ctx.submitFrom(el),
        onFocus: () => ctx.focused(el, true),
        onBlur: () => ctx.focused(el, false),
      });
      break;
    }
    default:
      return null;
  }
  // Two boxes, always: the one the widget shows through, and in it the
  // element's. A widget the document comes to cut, or stops cutting, is
  // the same widget in the same place in the tree, and keeps its focus
  // and its caret.
  return hx(
    'box',
    {
      key,
      selectable: false,
      style: {
        position: 'absolute',
        left: port.x,
        top: port.y,
        width: port.width,
        height: port.height,
        // cut to it, and nothing itself: a press beside the widget is the
        // document's
        ...(rect.clip && { overflow: 'hidden', pointerEvents: 'box-none' }),
      },
    },
    hx(
      'box',
      {
        ref: ctx.widgets.refOf(el),
        style: frame,
        selectable: false,
        // a control the page keeps from assistive technology is kept from
        // it here: core leaves the node, and the widget in it, out of the
        // accessibility tree
        ...(ariaHidden(el) && { 'aria-hidden': true }),
      },
      browser
        ? h(
            ThemeProvider,
            {
              value: BROWSER_CONTROLS[browser],
              colorScheme: browser,
              style: FILL,
            },
            widget,
          )
        : widget,
    ),
  );
}

const FILL: Style = { width: '100%', height: '100%' };

/**
 * Chrome's own controls in each scheme, for a control whose scheme is not
 * the palette's: the system colours the document's are in that scheme
 * (`browserSystemColor`), and the hover and pressed fills and the accent
 * of Blink's native theme (`NativeThemeBase`'s control colours, light and
 * dark). A control that says nothing of its scheme in a dark application
 * is drawn as Chrome draws it on a dark desktop — light — on the page that
 * is light for the same reason, where the palette's would be a dark well
 * in it.
 *
 * Every colour a core widget reads is named, since what is left out is
 * the palette's, in the other scheme: a light button's hover would be the
 * dark palette's. The shape — radius, padding, the size of the text, the
 * focus ring — stays the palette's, as it does for every control here.
 * A `<Button>` with a native bezel takes its appearance from `scheme`.
 */
const BROWSER_CONTROLS: Record<'light' | 'dark', BrowserPalette> = {
  light: browserControls('light', {
    surfaceHover: '#e5e5e5',
    surfaceActive: '#f5f5f5',
    border: '#767676',
    accent: '#0075ff',
    accentHover: '#005cc8',
    accentActive: '#3793ff',
    accentText: '#ffffff',
  }),
  dark: browserControls('dark', {
    surfaceHover: '#7b7b7b',
    surfaceActive: '#616161',
    border: '#858585',
    accent: '#99c8ff',
    accentHover: '#d1e6ff',
    accentActive: '#61a9ff',
    accentText: '#3b3b3b',
  }),
};

/**
 * A palette with the scheme it is in. Every palette core builds has
 * `scheme`, and a native bezel reads its appearance from it, but core's
 * `Theme` declaration leaves it out — narrower than its runtime, so it is
 * written here rather than patched there.
 */
type BrowserPalette = Partial<Theme> & { scheme: 'light' | 'dark' };

function browserControls(
  scheme: 'light' | 'dark',
  native: Partial<Theme>,
): BrowserPalette {
  const text = browserSystemColor('buttontext', scheme);
  return {
    scheme,
    background: browserSystemColor('field', scheme),
    surface: browserSystemColor('buttonface', scheme),
    text,
    textMuted: browserSystemColor('graytext', scheme),
    textMutedActive: text,
    track: browserSystemColor('buttonface', scheme),
    hoverBackground: native.accent,
    hoverText: native.accentText,
    borderFocus: native.accent,
    selection: browserSystemColor('highlight', scheme),
    // `caret-color: auto`, the text's own
    caret: null,
    ...native,
  };
}

/**
 * What an element's `tabindex` says of its widget's place in the Tab order
 * (HTML 6.6.3): a negative one is focusable — by a press, by its label, by
 * `autofocus` — and not reached by Tab, which is core's `tabIndex={-1}`
 * too. Radix lays a native `<select tabindex="-1" aria-hidden="true">`
 * beside the picker it draws, cut to nothing: it was a stop the eye could
 * not find, and Space on it opened an empty menu.
 *
 * Nothing else is handed over. Zero is where a control already is, and a
 * positive one would put a page's control ahead of the application's own,
 * whose window it is: the order between a document and what is around it
 * is not the document's to set.
 */
function tabOrder(el: Element): { tabIndex: -1 } | undefined {
  const index = tabIndexOf(el);
  return index !== null && index < 0 ? { tabIndex: -1 } : undefined;
}

/** Whether an element is hidden from assistive technology: `aria-hidden`
 *  is true on it or on an element around it (WAI-ARIA 1.2, 6.6). */
function ariaHidden(el: Element): boolean {
  for (let at: Element | null = el; at;) {
    if (attr(at, 'aria-hidden')?.trim().toLowerCase() === 'true') return true;
    const parent: Element['parent'] = at.parent;
    at = isElement(parent) ? parent : null;
  }
  return false;
}

/** How far past its box a widget's focus ring is drawn, and then some. */
const RING_REACH = 8;

/**
 * A text field's box: all of its frame, and no focus ring of its own. Its
 * ring is its element's `outline`, which the document draws round the
 * border box (the UA sheet's `:focus-visible`), so a page's
 * `outline: none` takes it away and a ring of the page's own replaces it,
 * as they do in a browser. Core's, drawn round the widget, stood inside the
 * border of a field the page drew, where the widget is only the content box.
 */
const FIELD_BOX: Style = { width: '100%', height: '100%', outlineWidth: 0 };

/** A field's `maxlength`, which the widget enforces as it is typed into. */
function maxLength(el: Element): number | undefined {
  const raw = attr(el, 'maxlength')?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/**
 * Why a form did not submit, under the control that stopped it — a
 * browser's validation bubble, in the palette's surface and border. Where
 * the control has no widget (a checkbox the page hid and drew its own), it
 * goes under the element's box; where it has neither, it is not shown, and
 * the form still does not submit, as in a browser.
 */
function renderMessage(
  invalid: { element: Element; message: string },
  rects: readonly ControlRect[],
  view: HtmlViewNode | null,
  look: RootLook,
): ReactNode {
  const rect =
    rects.find((r) => r.element === invalid.element) ??
    view?.elementRect(invalid.element) ??
    null;
  if (!rect) return null;
  return hx(
    'box',
    {
      key: 'form-message',
      selectable: false,
      style: {
        position: 'absolute',
        left: Math.round(rect.x),
        top: Math.round(rect.y + rect.height + 4),
        maxWidth: 320,
        paddingLeft: 10,
        paddingRight: 10,
        paddingTop: 6,
        paddingBottom: 6,
        backgroundColor: look.surface,
        borderWidth: look.controlBorder,
        borderColor: look.borderColor,
        borderRadius: look.controlRadius,
        zIndex: 1,
      },
    },
    hx(
      'text',
      {
        style: {
          color: look.color,
          fontFamily: look.fontFamily,
          fontSize: Math.round(look.fontSize * 0.9),
        },
      },
      invalid.message,
    ),
  );
}

/**
 * The chrome a text field needs.
 *
 * `<textinput>` and `<textarea>` are core *elements* rather than components,
 * so they draw no frame of their own — an application supplies one, which is
 * why core's own `<Button>` and `<Select>` are components and these are not.
 * The values are the palette's, so a field in a document and a `<Select>`
 * beside it are the same height with the same corner and the same edge.
 * Its text is in the face and at the size of the frame around it, which
 * are the element's (`renderControl`). A field in the scheme that is not
 * the palette's keeps the palette's shape in Blink's colours for that
 * scheme: a `Field` ground, `FieldText` ink, and the grey edge Blink's
 * UA sheet gives a text area.
 */
function fieldChrome(look: RootLook, browser: 'light' | 'dark' | null): Style {
  const palette = browser && BROWSER_CONTROLS[browser];
  return {
    backgroundColor: palette ? palette.background : look.surface,
    borderWidth: look.controlBorder,
    borderColor: palette ? palette.border : look.borderColor,
    borderRadius: look.controlRadius,
    paddingLeft: 6,
    paddingRight: 6,
    color: browser ? browserSystemColor('fieldtext', browser) : look.color,
  };
}

/**
 * A text field whose box the author styled: the document draws the border
 * and the background, so the widget draws neither, and its text is the
 * element's colour, which the author chose to go on that background, rather
 * than the theme's. Its face and size are the frame's, as every field's are.
 */
function bareField(bare: BareField): Style {
  return {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
    paddingLeft: 0,
    paddingRight: 0,
    color: bare.color,
  };
}

/**
 * Whether a control is set in the face and at the size the UA sheet gives
 * a button or a select, the palette's: the page left its font alone. The
 * size is compared loosely, since the rect's is a device size divided back
 * by the scale.
 */
function paletteFont(rect: ControlRect, look: RootLook): boolean {
  return (
    rect.fontFamily === (look.controlFontFamily ?? look.fontFamily) &&
    Math.abs(rect.fontSize - (look.controlFontSize ?? look.fontSize)) < 0.01
  );
}

/**
 * The trigger of a `<select>` whose box the page styled: no frame, no fill
 * and none of its own insets, and no wash under the pointer, since the box
 * it would tint is the document's. Core's focus ring still marks it for the
 * keyboard.
 */
const BARE_TRIGGER: Style = {
  paddingTop: 0,
  paddingBottom: 0,
  paddingLeft: 0,
  paddingRight: 0,
  borderWidth: 0,
  borderRadius: 0,
  backgroundColor: 'transparent',
  ':hover': { backgroundColor: 'transparent' },
  ':active': { backgroundColor: 'transparent' },
};

/** Select the option of a drop-down `<select>` whose value is `value`, and
 *  no other. */
function setSelectedOption(el: Element, value: string): void {
  let found = false;
  for (const option of optionElements(el)) {
    if (!found && optionValue(option) === value) {
      option.attribs.selected = '';
      found = true;
    } else {
      delete option.attribs.selected;
    }
  }
}
