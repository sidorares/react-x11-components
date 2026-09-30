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
// which is why this also watches the document's own presses.
//
// What the markup cannot say — what was typed, what a reset puts back — is
// `FormState`'s (form.ts), one per `<Html>`, and what a submission carries
// and where it goes is form.ts's too. This is the half that has a React
// tree.
import React from 'react';
import type { ReactNode } from 'react';
import { Button, Checkbox, Radio, RadioGroup, Select } from 'react-x11';
import type { DrawnNode, MouseEvent as X11MouseEvent } from 'react-x11';
import type { Style } from 'react-x11/style';

import type {} from 'react-x11/jsx-runtime';

import { cancelLater, later } from '../internal/timers.js';
import { hx } from './hx.js';
import { attr, tagOf } from './dom.js';
import type { Document, Element } from './dom.js';
import type { HtmlViewNode } from './node.js';
import type { RootLook } from './css/style.js';
import { buttonLabel, optionsOf, selectedOption } from './controls.js';
import type { BareField, ControlRect } from './controls.js';
import {
  FormState,
  buttonType,
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
  /** The document's own presses: its `<button>`s, `<label>`s and image
   *  buttons. */
  onMouseDown: (ev: X11MouseEvent<DrawnNode>) => void;
  onMouseUp: (ev: X11MouseEvent<DrawnNode>) => void;
  /** The widgets for the rectangles layout reported, and the message of a
   *  form that would not submit. */
  render(rects: readonly ControlRect[], look: RootLook): ReactNode[];
}

/** How far a press may travel and still be a click — `useLinkClicks`'s
 *  rule, so a link and a button in one document agree about it. */
const CLICK_SLOP = 4;

/** How long a validation message stays, as a browser's bubble does. */
const MESSAGE_MS = 5000;

export function useForms(options: FormsOptions): Forms {
  const { view, baseUrl, onControlChange, onSubmit, touch } = options;

  // What the controls hold that the markup does not, for the widgets'
  // next mount, a submission and a reset. A reset bumps `resets`, which is
  // in every widget's key: an uncontrolled field shows its markup's value
  // again only by mounting again.
  const forms = React.useMemo(() => new FormState(), []);
  const live = (el: Element) => forms.typed(el);
  const [resets, setResets] = React.useState(0);
  const [invalid, setInvalid] = React.useState<{
    element: Element;
    message: string;
  } | null>(null);

  // Each element's widget is keyed by the element, not by where it is: a
  // field that layout moves — a stylesheet arriving, an image above it
  // loading, a resize — is the same widget, and keeps its focus, its caret
  // and its undo. Keyed by position, each move mounted a new one, and a
  // page whose stylesheet landed while someone was typing lost the field
  // from under them.
  const widgets = React.useMemo(() => new WidgetBoxes(), []);

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
      setResets((n) => n + 1);
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
    generation: resets,
    widgets,
    changed,
    setChecked,
    checkRadio,
    press,
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
      const out = rects.map((rect) => renderControl(rect, look, ctx));
      if (invalid) {
        const bubble = renderMessage(invalid, rects, view.current, look);
        if (bubble) out.push(bubble);
      }
      return out;
    },
  };
}

/** What a press in the document can be a press of. */
type Pressable =
  | { kind: 'button'; element: Element }
  | { kind: 'image'; element: Element }
  | { kind: 'label'; element: Element; control: Element };

/**
 * The thing a press lands on: the nearest `<button>`, image button or
 * `<label>` around the element under it. A link inside one is the link's,
 * and a disabled button is pressed by nobody; a label with nothing to label
 * is only text.
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
  private _refs = new WeakMap<Element, (node: DrawnNode | null) => void>();

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
        if (node) this._boxes.set(el, node);
        else if (this._boxes.get(el)) this._boxes.delete(el);
      };
      this._refs.set(el, ref);
    }
    return ref;
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
  /** How many resets there have been — in every widget's key, so a reset
   *  mounts each again with the value its markup has. */
  generation: number;
  widgets: WidgetBoxes;
  changed: (el: Element, value: string | boolean, restyle: boolean) => void;
  setChecked: (el: Element, checked: boolean) => void;
  checkRadio: (el: Element) => void;
  /** A button was pressed: what it does to its form. */
  press: (button: Element) => void;
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
  const key = `${rect.kind}:${ctx.widgets.idOf(el)}#${ctx.generation}`;
  const disabled = isDisabled(el);
  const readOnly = attr(el, 'readonly') !== undefined;
  // a field whose box the document draws takes its content box
  const at = rect.bare ?? rect;
  const frame: Style = {
    position: 'absolute',
    left: Math.round(at.x),
    top: Math.round(at.y),
    width: Math.round(at.width),
    height: Math.round(at.height),
    // core's `opacity` is CSS's: the widget faded as a group, and at 0 not
    // drawn and still hit
    ...(rect.opacity !== undefined && { opacity: rect.opacity }),
  };
  const field = rect.bare ? bareField(rect.bare) : fieldChrome(look);
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
        // the element's whole box takes the press, as it does in a browser:
        // a page that sizes one over its label, invisible, means the label
        style: { width: '100%', height: '100%' },
        onChange: (ev) => ctx.setChecked(el, ev.value),
      });
      break;
    case 'radio': {
      const value = attr(el, 'value') ?? 'on';
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
        style: { width: '100%', height: '100%' },
        onPress: () => ctx.press(el),
      });
      break;
    case 'select': {
      const options = optionsOf(el);
      widget = h(Select, {
        options: options.map((o) => ({ value: o.value, label: o.label })),
        value: selectedOption(el) ?? undefined,
        disabled,
        style: rect.bare
          ? [BARE_TRIGGER, { width: '100%', height: '100%' }]
          : { width: '100%', height: '100%' },
        // the slots choose the drawn trigger on every backend, and put the
        // caption and the arrow in the page's ink
        ...(rect.bare && {
          labelStyle: {
            color: rect.bare.color,
            fontFamily: rect.bare.fontFamily,
            fontSize: rect.bare.fontSize,
          },
          chevronStyle: rect.bare.chevron
            ? { color: rect.bare.color }
            : { display: 'none' },
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
      // shown, a reset — starts from what `forms` kept of it.
      widget = hx('textarea', {
        defaultValue: forms.value(el),
        maxLength: maxLength(el),
        style: [field, { width: '100%', height: '100%' }],
        onChange: readOnly ? undefined : (ev) => typed(ev.value),
      });
      break;
    case 'input': {
      const type = inputType(el);
      widget = hx('textinput', {
        defaultValue: forms.value(el),
        placeholder: attr(el, 'placeholder'),
        maxLength: maxLength(el),
        // Core's word for a password field: nothing in it reaches a
        // selection, PRIMARY included.
        sensitive: type === 'password',
        style: [field, { width: '100%', height: '100%' }],
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
      });
      break;
    }
    default:
      return null;
  }
  return hx(
    'box',
    {
      key,
      ref: ctx.widgets.refOf(el),
      style: frame,
      selectable: false,
    },
    widget,
  );
}

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
    // the size the UA sheet sets the field at, and so measured it at
    fontSize: look.controlFontSize ?? look.fontSize,
  };
}

/**
 * A text field whose box the author styled: the document draws the border
 * and the background, so the widget draws neither, and its text is the
 * element's colour and font, which the author chose to go on that
 * background, rather than the theme's.
 */
function bareField(bare: BareField): Style {
  return {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
    paddingLeft: 0,
    paddingRight: 0,
    color: bare.color,
    fontFamily: bare.fontFamily,
    fontSize: bare.fontSize,
  };
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
