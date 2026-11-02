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
import type { ReactElement, ReactNode } from 'react';
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
import { controlAnswers } from './control-state.js';
import { hx } from './hx.js';
import {
  attr,
  isDropDown,
  isElement,
  isInputButton,
  setPickerOpen,
  tagOf,
} from './dom.js';
import type { Document, Element, HtmlChange } from './dom.js';
import type { HtmlViewNode } from './node.js';
import { browserSystemColor } from './css/color.js';
import type { RootLook } from './css/style.js';
import {
  AT_VIEWPORT,
  HELD_AT_VIEWPORT,
  between,
  buttonLabel,
  optionsOf,
  selectedOption,
} from './controls.js';
import type { BareField, ControlRect } from './controls.js';
import { fireDomEvent, modifiersOf } from './dom-events.js';
import type {
  DomEventHandler,
  DomEventInit,
  HtmlDomEventType,
} from './dom-events.js';
import {
  FormState,
  buttonType,
  controlChange,
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
  setIndeterminate,
  setUserValidity,
} from './form.js';
import type { FieldSelection, FormSubmission } from './form.js';
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
  /** What happened, before what it does: `onDomEvent` (`dom-events.ts`). */
  onDomEvent?: DomEventHandler;
  /** Restyle and lay out again: a change a selector can see, told as
   *  what it did to the document where that is known. */
  touch: (changes?: readonly HtmlChange[]) => void;
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
  /** What has the document's focus loses it now, told at once where a blur
   *  is told a microtask later: core's focus went to what is no element of
   *  the document's, as a modal dialog with nothing to focus gives it to
   *  the document, and a focus given back in the same task is news. */
  letGo(): void;
  /** The page has been told `el` has the focus, and nothing of the
   *  document's is there yet to take it: what `owed` answers until something
   *  does, or the focus goes elsewhere. */
  owe(el: Element): void;
  /** What the page has been told has the focus that nothing has taken yet,
   *  or null: `activeElement`, and what the next render hands on. */
  owed(): Element | null;
  /** What the user last did in the document, heard before anything else
   *  hears it: a press, or a key that is not a modifier's or a chord's. */
  userInput(kind: 'pointer' | 'keyboard'): void;
  /**
   * A script asks for `el` to take the focus (`HtmlHandle.focus`), or,
   * given null, takes back an ask that came to nothing. The focus it gives
   * shows, `:focus-visible`, where the user's last input in the document
   * was not a press, as Chrome, Firefox and WebKit decide it: a menu a
   * click opens and a script focuses the first link of draws no ring
   * round it, where Tab and Enter, or no input at all, draw one.
   */
  scriptFocus(el: Element | null): void;
  /** What a control holds, as a script reads `value` or `checked`: typed
   *  text, the option a `<select>` shows, whether a box is ticked. Null for
   *  what is no control. */
  value(el: Element): string | boolean | null;
  /** Set what a control holds as a script sets it: no event, and a field's
   *  widget shows it where it is, caret and focus kept. False for what is
   *  no control. */
  setValue(el: Element, value: string | boolean): boolean;
  /** A text field's selection, as a script reads `selectionStart`,
   *  `selectionEnd` and `selectionDirection`: its widget's, where one is
   *  mounted that says, and else what was last set or kept of it — a caret
   *  at the end of its text where nothing was. Null for what is no text
   *  field. */
  selection(el: Element): FieldSelection | null;
  /** Select in a text field as a script's `setSelectionRange` does, its
   *  offsets clamped to its text: no event, and its widget shows it where
   *  one is mounted that takes it — as it does the next one mounted. False
   *  for what is no text field. */
  setSelection(el: Element, selection: FieldSelection): boolean;
  /** Drop a `<select>`'s menu as a script's `showPicker()` does, where its
   *  widget can be asked to (`holdsOpen`): false where nothing opens — a
   *  list box, a disabled one, what has no picker here. */
  showPicker(el: Element): boolean;
  /** HTML's interactive validation: true where the form may go, and else
   *  false, with the reason shown at the first control that is wrong. */
  validate(
    form: Element,
    submitter: Element | null,
    attempt?: boolean,
  ): boolean;
  /** Send a form as `form.submit()` does: no validation, no `submit`. */
  submitNow(form: Element, submitter: Element | null): void;
  /** Put a form back as `form.reset()` does, after its `reset` event. */
  resetNow(form: Element): void;
}

/** How far a press may travel and still be a click — `useLinkClicks`'s
 *  rule, so a link and a button in one document agree about it. */
const CLICK_SLOP = 4;

/** How long a validation message stays, as a browser's bubble does. */
const MESSAGE_MS = 5000;

export function useForms(options: FormsOptions): Forms {
  const { view, baseUrl, onControlChange, onSubmit, onDomEvent, touch } =
    options;
  /** Tell the host what happened; whether the default goes on. */
  const fire = (
    type: HtmlDomEventType,
    target: Element,
    init?: DomEventInit,
  ): boolean => fireDomEvent(onDomEvent, type, target, init);

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
      new WidgetBoxes({
        gone: (el) => {
          // a field that unmounts with the focus is forgotten rather than
          // blurred, and the document is told it went
          const node = view.current;
          if (node?.focusedElement === el) node.setFocus(null);
          // and a select's menu goes with its widget
          if (picker.current === el) pickerChanged(el, false);
        },
        // A field's selection outlives its widget, as an input's outlives
        // a `display: none`: what the widget had as it went is kept, and
        // the next one mounted for the element starts from it, or from
        // what a script set while none was.
        leaving: (el) => {
          const field = selectingField(widgets.fieldOf(el));
          if (field) forms.keepSelection(el, selectionOf(field));
        },
        came: (el) => {
          // A menu a script asked for before its widget was mounted, by a
          // core whose select turns out to keep its menu to itself: no
          // menu is down, and `:open` says so.
          if (
            picker.current === el &&
            holdsOpen(widgets.triggerOf(el)) === false
          ) {
            pickerChanged(el, false);
          }
          const kept = forms.selection(el);
          const field = kept && selectingField(widgets.fieldOf(el));
          if (!field) return;
          field.setSelectionRange(kept.start, kept.end, kept.direction);
          seen.current.set(el, selectionOf(field));
        },
      }),
    [view, forms],
  );

  // Whose picker is open: the `<select>` whose menu is down, as its widget
  // tells it (`onOpenChange`) or a script's `showPicker()` asks for it. The
  // widget's `open` is this (`renderControl`), so its menu follows, and so
  // does `:open` (`isPickerOpen`), told as a change of an attribute nothing
  // has: a restyle in place where it only inks, as a hover is. One menu is
  // down at a time, as a popup that grabs the pointer has it.
  const picker = React.useRef<Element | null>(null);
  const [, setPicker] = React.useState<Element | null>(null);
  const tellPicker = (el: Element, open: boolean) => {
    if (!setPickerOpen(el, open)) return;
    view.current?.touchDocument([
      { type: 'attributes', target: el, attributeName: '-rx-picker-open' },
    ]);
  };
  const pickerChanged = (el: Element, open: boolean) => {
    const was = picker.current;
    if (open ? was === el : was !== el) return;
    picker.current = open ? el : null;
    if (was && was !== el) tellPicker(was, false);
    tellPicker(el, open);
    setPicker(picker.current);
  };

  // What each field's selection was last seen as, by a script's setting it
  // or a gesture's end: a key, a press or a release in the field that
  // leaves another range selected is its `select`, as Chrome tells one
  // (HTML 4.10.5.2.10, "user agents should fire select"), and one that
  // only moves a caret is none. Looked at a microtask after the event, when
  // core's default action has moved the selection.
  const seen = React.useRef(new WeakMap<Element, FieldSelection>());
  const watchSelection = (el: Element) => {
    void Promise.resolve().then(() => {
      const field = selectingField(widgets.fieldOf(el));
      if (!field) return;
      const now = selectionOf(field);
      const was = seen.current.get(el);
      seen.current.set(el, now);
      if (now.start === now.end) return;
      if (was && was.start === now.start && was.end === now.end) return;
      fire('select', el);
    });
  };

  // Which element's field holds the focus, for `:focus` and its kin
  // (`HtmlViewNode.setFocus`). A blur is told a microtask later, and only
  // where no field took the focus in the meantime: core blurs one field
  // and then focuses the next, and a move from one to the other is one
  // change to the document, not two.
  //
  // The host hears it as the DOM tells it: `focusout` on the one that had
  // it, then `focusin` on the one that took it, each naming the other —
  // so a move tells the one leaving first, though core's blur comes to
  // this after the focus. And a text field that lost the focus with
  // another value than it took it with has a `change` (HTML 4.10.5.5).
  const blurred = React.useRef<Element | null>(null);
  const holder = React.useRef<Element | null>(null);
  // What a script focused before a widget or a stop was there to take it,
  // which may be a good while on a page still loading (`owe`). The page was
  // told it has the focus and goes by that: Monaco, believing it, asks for
  // nothing when it is pressed, so a focus let go of here was never had.
  const owedTo = React.useRef<Element | null>(null);
  // the user's last input in the document, and the element a script last
  // asked to focus with whether its focus shows (`scriptFocus`)
  const lastInput = React.useRef<'pointer' | 'keyboard' | null>(null);
  const asked = React.useRef<{ el: Element; visible: boolean } | null>(null);
  const leave = (el: Element, to: Element | null) => {
    // what the user typed in it shows from here: while they type, a field
    // is not told off for what they have not finished (HTML 4.10.18.5)
    if (forms.takeEdited(el)) showValidity(el);
    commit(el);
    fire('focusout', el, { relatedTarget: to });
  };
  const focused = (el: Element, on: boolean) => {
    if (on) {
      blurred.current = null;
      owedTo.current = null;
      const was = holder.current;
      holder.current = el;
      if (was !== el) {
        if (was) leave(was, el);
        if (isTextField(el)) values.current.set(el, forms.value(el));
        fire('focusin', el, { relatedTarget: was });
      }
      // what accepts typing shows however it took the focus (Selectors 4,
      // 9.4); what a script focused, as its ask said
      const ask = asked.current;
      if (ask?.el === el) asked.current = null;
      const visible = isTextField(el) || ask?.el !== el || ask.visible;
      view.current?.setFocus(el, visible);
      return;
    }
    blurred.current = el;
    void Promise.resolve().then(() => {
      if (blurred.current !== el) return;
      blurred.current = null;
      if (holder.current === el) {
        holder.current = null;
        leave(el, null);
      }
      const node = view.current;
      if (node?.focusedElement === el) node.setFocus(null);
    });
  };

  const letGo = () => {
    const el = holder.current;
    owedTo.current = null;
    if (!el) return;
    blurred.current = null;
    holder.current = null;
    leave(el, null);
    const node = view.current;
    if (node?.focusedElement === el) node.setFocus(null);
  };

  /** What a rule can read of a control, to tell whether a change moved it:
   *  nothing where no rule reads any, so a keystroke in a document with
   *  none works nothing out. */
  const answers = (el: Element): number =>
    view.current?.readsControls ? controlAnswers(el) : 0;
  /** The change to tell of a control, where what a rule reads of it is not
   *  what it was: no refresh for a keystroke that moved no answer. */
  const answersMoved = (
    el: Element,
    was: number,
  ): readonly HtmlChange[] | null =>
    view.current?.readsControls && controlAnswers(el) !== was
      ? [controlChange(el)]
      : null;
  /** A control's validity is the user's to see from now: `:user-valid` and
   *  `:user-invalid`. */
  const showValidity = (el: Element) => {
    if (setUserValidity(el, true) && view.current?.readsControls) {
      touch([controlChange(el)]);
    }
  };

  // What each text field held when it took the focus, or at its last
  // `change`: a field that leaves the focus, or is submitted from, with
  // something else has a `change`.
  const values = React.useRef(new WeakMap<Element, string>());
  const commit = (el: Element) => {
    if (!isTextField(el)) return;
    const was = values.current.get(el);
    const now = forms.value(el);
    if (was === undefined || was === now) return;
    values.current.set(el, now);
    fire('change', el);
  };

  React.useEffect(() => {
    if (!invalid) return;
    const timer = later(() => setInvalid(null), MESSAGE_MS);
    return () => cancelLater(timer);
  }, [invalid]);

  /** A form that would send what its own constraints refuse says why, at
   *  the first control that is wrong, and sends nothing. */
  const validate = (form: Element, submitter: Element | null): boolean => {
    const wrong = firstInvalid(form, submitter, live);
    if (wrong) {
      setInvalid(wrong);
      widgets.focus(wrong.element);
      return false;
    }
    setInvalid(null);
    return true;
  };

  /** The entry list, built as the form is now, and sent. */
  const send = (form: Element, submitter: Element | null, point?: Point) => {
    if (!onSubmit) return;
    const node = view.current;
    const submission = formSubmission(form, submitter, {
      base: node?.documentBase ?? baseUrl ?? null,
      documentUrl: baseUrl ?? null,
      live,
      point,
    });
    if (submission) onSubmit(submission);
  };

  /** A form the user tried to send shows what is wrong with all of it, a
   *  form with `novalidate` too (HTML 4.10.21.3). */
  const attempted = (form: Element) => {
    const moved = controlsOf(form).filter((el) => setUserValidity(el, true));
    if (moved.length && view.current?.readsControls) {
      touch(moved.map(controlChange));
    }
  };

  /**
   * HTML's order (4.10.21.3, "form submission algorithm"): the form is
   * validated, then its `submit` is asked about, and the entry list is
   * built after it — so a handler that fills in a hidden field has it
   * sent. Built before, as it was, the field went empty.
   */
  const submit = (form: Element, submitter: Element | null, point?: Point) => {
    attempted(form);
    if (!onSubmit && !onDomEvent) return;
    if (!validate(form, submitter)) return;
    if (!fire('submit', form, { submitter })) return;
    send(form, submitter, point);
  };

  /** Put a form back as its markup has it (HTML 4.10.21.5). */
  const resetNow = (form: Element) => {
    if (!forms.reset(form)) return;
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
    else if (fire('reset', form)) resetNow(form);
  };

  /** A control's value changed: tell the application, and let a message
   *  about it go. */
  const changed = (
    el: Element,
    value: string | boolean,
    restyle: readonly HtmlChange[] | null,
  ) => {
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
    if (restyle) touch(restyle);
  };

  const tick = (el: Element, checked: boolean): HtmlChange => {
    const oldValue = attr(el, 'checked') ?? null;
    forms.remember(el);
    if (checked) el.attribs.checked = '';
    else delete el.attribs.checked;
    return {
      type: 'attributes',
      target: el,
      attributeName: 'checked',
      oldValue,
    };
  };

  /**
   * A box ticked or unticked as a click does it (HTML 4.10.5.1.15): the
   * box changes first, then the click is asked about, and a cancelled click
   * puts it back — the widget shown as it was. One that was not is an
   * `input` and a `change`.
   */
  const setChecked = (el: Element, checked: boolean, init?: DomEventInit) => {
    const was = attr(el, 'checked') !== undefined;
    const mixed = setIndeterminate(el, false);
    const ticked = tick(el, checked);
    if (!fire('click', el, { detail: 1, ...init })) {
      if (mixed) setIndeterminate(el, true);
      touch([ticked, tick(el, was)]);
      return;
    }
    setUserValidity(el, true);
    changed(el, checked, [ticked]);
    fire('input', el);
    fire('change', el);
  };

  // Core's radio is a group member and HTML's is a free-standing input that
  // happens to share a `name`. Each one is therefore its own one-member
  // `RadioGroup`, and the exclusivity that makes it a group is done where
  // HTML keeps it: in the DOM, across the radios of its name in its form.
  // Checked first and asked about after, as a box is, and a cancelled click
  // checks the one that was again (HTML 4.10.5.1.18).
  const checkRadio = (el: Element, init?: DomEventInit) => {
    const own = attr(el, 'checked') !== undefined;
    const before = radioGroup(el).filter(
      (other) => attr(other, 'checked') !== undefined,
    );
    const ticked = before.map((other) => tick(other, false));
    ticked.push(tick(el, true));
    if (!fire('click', el, { detail: 1, ...init })) {
      ticked.push(tick(el, own));
      for (const other of before) ticked.push(tick(other, true));
      touch(ticked);
      return;
    }
    setUserValidity(el, true);
    changed(el, attr(el, 'value') ?? 'on', ticked);
    if (own) return;
    fire('input', el);
    fire('change', el);
  };

  /** A click on what a click activates, asked about first: what is run
   *  only where it was not cancelled. */
  const click = (el: Element, init: DomEventInit, then: () => void) => {
    if (fire('click', el, { detail: 1, ...init })) then();
  };

  /** A summary's activation behaviour (HTML 4.11.2): its details open, or
   *  close. The attribute is the state, as `checked` is a checkbox's, and
   *  `details[open]` a selector a sheet styles by. */
  const toggleDetails = (summary: Element) => {
    const details = summary.parent as Element;
    const oldValue = attr(details, 'open') ?? null;
    if (oldValue !== null) delete details.attribs.open;
    else details.attribs.open = '';
    touch([
      { type: 'attributes', target: details, attributeName: 'open', oldValue },
    ]);
    fire('toggle', details);
  };

  /** A press on a `<label>` is a click on its control (HTML 4.10.4): a
   *  box is toggled, a radio checked, a button pressed, and a field
   *  focused — each after a click on the control the host may cancel. */
  const activateLabel = (control: Element) => {
    if (isDisabled(control)) return;
    const tag = tagOf(control);
    const type = tag === 'input' ? inputType(control) : '';
    if (type === 'checkbox') {
      setChecked(control, attr(control, 'checked') === undefined);
    } else if (type === 'radio') {
      if (attr(control, 'checked') === undefined) checkRadio(control);
      else fire('click', control, { detail: 1 });
    } else if (tag === 'button' || buttonType(control) !== null) {
      click(control, {}, () =>
        press(control, type === 'image' ? { x: 0, y: 0 } : undefined),
      );
    } else if (fire('click', control, { detail: 1 })) {
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
    picker: picker.current,
    pickerChanged,
    answers,
    answersMoved,
    changed,
    setChecked,
    checkRadio,
    press,
    click,
    focused,
    input: (el) => fire('input', el),
    watchSelection,
    selected: (el) => {
      showValidity(el);
      fire('input', el);
      fire('change', el);
    },
    submitFrom: (field) => {
      // what was typed is committed before the form goes, as Enter
      // commits it in a browser
      commit(field);
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
    value: (el) => controlState(el, forms),
    setValue: (el, value) => {
      const tag = tagOf(el);
      const type = tag === 'input' ? inputType(el) : '';
      if (type === 'checkbox' || type === 'radio') {
        const on = value === true || value === 'true';
        const ticked =
          on && type === 'radio'
            ? radioGroup(el).map((other) => tick(other, false))
            : [];
        ticked.push(tick(el, on));
        touch(ticked);
        return true;
      }
      // a boolean is a checkedness, which no other control shows: never
      // its text, which `String(false)` would have made it
      if (typeof value === 'boolean') return false;
      if (tag === 'select') {
        forms.remember(el);
        touch(setSelectedOption(el, String(value)));
        return true;
      }
      if (!isTextField(el)) return false;
      const text = String(value);
      const was = answers(el);
      forms.setTyped(el, text, true);
      // a value set is no change the user made: what the field held when
      // it took the focus is this now, as a browser's is
      if (values.current.has(el)) values.current.set(el, text);
      const field = widgets.fieldOf(el);
      if (field) field.value = text;
      const moved = answersMoved(el, was);
      if (moved) touch(moved);
      return true;
    },
    selection: (el) => {
      if (!isTextField(el)) return null;
      const field = selectingField(widgets.fieldOf(el));
      if (field) return selectionOf(field);
      const end = forms.value(el).length;
      return forms.selection(el) ?? { start: end, end, direction: 'none' };
    },
    setSelection: (el, selection) => {
      if (!isTextField(el)) return false;
      const length = forms.value(el).length;
      const end = clampOffset(selection.end, length);
      const kept: FieldSelection = {
        start: clampOffset(selection.start, end),
        end,
        direction: selection.direction,
      };
      forms.keepSelection(el, kept);
      const field = selectingField(widgets.fieldOf(el));
      if (field) field.setSelectionRange(kept.start, kept.end, kept.direction);
      seen.current.set(el, field ? selectionOf(field) : kept);
      return true;
    },
    showPicker: (el) => {
      if (!isDropDown(el) || isDisabled(el)) return false;
      // Asked before its widget is mounted — a select just shown — it is
      // down from the widget's first commit, where the core's select takes
      // `open`; `came` finds out where it does not.
      if (holdsOpen(widgets.triggerOf(el)) === false) return false;
      pickerChanged(el, true);
      return true;
    },
    validate: (form, submitter, attempt) => {
      if (attempt) attempted(form);
      return validate(form, submitter);
    },
    submitNow: (form, submitter) => send(form, submitter),
    resetNow,
    activate: (el) => {
      const tag = tagOf(el);
      if (tag === 'summary') {
        toggleDetails(el);
        return true;
      }
      if (isDisabled(el)) return false;
      if (tag === 'button' || isInputButton(el)) {
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
    letGo,
    owe: (el) => {
      owedTo.current = el;
    },
    // not one taken out since, which nothing will come for
    owed: () => (owedTo.current?.parent ? owedTo.current : null),
    userInput: (kind) => {
      lastInput.current = kind;
    },
    scriptFocus: (el) => {
      asked.current = el
        ? { el, visible: lastInput.current !== 'pointer' }
        : null;
    },
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
    // a `<button>`, and an input button the document draws, which a press
    // on its palette widget would not reach here
    if (tag === 'button' || isInputButton(node)) {
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

  /** `came` hears of each element whose widget's box mounted, with the
   *  widget in it; `leaving` of each whose box is unmounting, while the
   *  widget can still be found; `gone` of it once it has. */
  constructor(
    private readonly _hooks: {
      came: (el: Element) => void;
      leaving: (el: Element) => void;
      gone: (el: Element) => void;
    },
  ) {}

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
          this._hooks.came(el);
        } else if (this._boxes.get(el)) {
          this._hooks.leaving(el);
          this._boxes.delete(el);
          this._hooks.gone(el);
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

  /** The trigger of `el`'s widget, where it is a `<Select>` and is
   *  mounted: the node in its box that is the combobox. */
  triggerOf(el: Element): DrawnNode | null {
    const box = this._boxes.get(el);
    const stack: DrawnNode[] = box ? [box] : [];
    while (stack.length) {
      const node = stack.pop()!;
      const props = (node as unknown as { props: Record<string, unknown> })
        .props;
      if (props.role === 'combobox') return node;
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
  /** The `<select>` whose menu is down, or null. */
  picker: Element | null;
  /** A `<select>`'s widget says its menu went down, or came up. */
  pickerChanged: (el: Element, open: boolean) => void;
  /** What a rule can read of a control, and the change to tell of it where
   *  that moved since. */
  answers: (el: Element) => number;
  answersMoved: (el: Element, was: number) => readonly HtmlChange[] | null;
  changed: (
    el: Element,
    value: string | boolean,
    restyle: readonly HtmlChange[] | null,
  ) => void;
  setChecked: (el: Element, checked: boolean) => void;
  checkRadio: (el: Element) => void;
  /** A button was pressed: what it does to its form. */
  press: (button: Element) => void;
  /** A click on a widget, asked about before `then` runs. */
  click: (el: Element, init: DomEventInit, then: () => void) => void;
  /** A field's widget took the focus, or gave it up. */
  focused: (el: Element, on: boolean) => void;
  /** Something was typed into a field: its `input`. */
  input: (el: Element) => void;
  /** A key, a press or a release in a field, whose selection it may have
   *  changed: its `select`, where it did. */
  watchSelection: (el: Element) => void;
  /** A `<select>` was given another option: its `input` and `change`. */
  selected: (el: Element) => void;
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
  // A text edit restyles only where it moved what a rule reads: the value
  // lives in the widget and in `forms`, and neither changes any box, while
  // a restyle per keystroke would re-run the cascade and lay the document
  // out each time. Typing updates the value, not the attribute selectors
  // match against, so `:invalid`, `:placeholder-shown` and their kin are
  // told as a change of an attribute nothing has, when their answer turns.
  // The checkables do restyle, because `:checked` is a selector documents
  // really use.
  const typed = (value: string) => {
    const was = ctx.answers(el);
    forms.setTyped(el, value);
    ctx.changed(el, value, ctx.answersMoved(el, was));
    ctx.input(el);
  };
  // what may leave a field's text selected: a key, Shift+arrow or Ctrl+A;
  // a press, a double click's word; a release, a drag's end
  const watch = () => ctx.watchSelection(el);
  const selectionWatch = {
    onKeyDown: watch,
    onMouseDown: watch,
    onMouseUp: watch,
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
        onPress: (ev) => ctx.click(el, modifiersOf(ev), () => ctx.press(el)),
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
        // Whether the menu is down is the document's, so `showPicker()`
        // drops it and `:open` follows it: what the user does asks, and is
        // told back (`pickerChanged`). A core whose select takes neither
        // hands both to its trigger's box, where `holdsOpen` sees them —
        // and declares neither, so they are spread past its types.
        ...({
          open: ctx.picker === el,
          onOpenChange: (open: boolean) => ctx.pickerChanged(el, open),
        } as object),
        disabled,
        ...order,
        style: rect.bare
          ? [BARE_TRIGGER, { width: '100%', height: '100%' }]
          : { width: '100%', height: '100%' },
        // the slots choose the drawn trigger on every backend, and put the
        // caption and the arrow in the page's ink
        ...(rect.bare && {
          labelStyle: {
            color: rect.bare.fill ?? rect.bare.color,
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
          ctx.changed(el, next, setSelectedOption(el, next));
          ctx.selected(el);
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
        // its caret is the field's text colour, as a text input's is
        ...(rect.bare && { caretColor: rect.bare.color }),
        style: [field, FIELD_BOX],
        onChange: readOnly ? undefined : (ev) => typed(ev.value),
        ...selectionWatch,
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
        // …and what it shows is a bullet a character, as Chrome draws its
        // `-webkit-text-security: disc` (HTML 4.10.5.1.3: obscured so
        // nobody else can see it)
        mask: type === 'password' ? '•' : undefined,
        // a browser's caret is the field's text colour (`caret-color:
        // auto`), which is the page's where the page drew the field — the
        // palette's own field keeps the palette's caret — and not what its
        // glyphs are filled with, which `-webkit-text-fill-color` may hide
        ...(rect.bare && { caretColor: rect.bare.color }),
        style: [field, FIELD_BOX],
        // What is typed is the field's value and not its `value`
        // attribute, which is its default (HTML 4.10.5.4): a script tells
        // `value` from `defaultValue`, and `[value=…]` matches the markup.
        // An application reads it with the handle's `controlValue`.
        onChange: readOnly ? undefined : (ev) => typed(ev.value),
        // Enter submits the field's form, as it does in a browser
        onSubmit: () => ctx.submitFrom(el),
        ...selectionWatch,
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
  const mounted = hx(
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
  return keptWithBox(rect, key, mounted);
}

/**
 * What is mounted for a control, kept where the document draws it: a
 * control in a box fixed to the viewport (`ControlRect.atViewport`) has its
 * rect where layout put it, at the document's top, and the document draws
 * the box where the viewport is. So its widget goes in a box of no size
 * that core keeps there (`AT_VIEWPORT`), as it keeps a sticky header, and
 * lands with the box in the frame the pane scrolls. Mounted at its rect
 * beside the element, a fixed header's search field scrolled away with the
 * text and left the header behind.
 *
 * A position moves a box laid out in the flow, and a pane reaches as far
 * as its content is laid out, not as far as it was moved: after the
 * element in the flow, the box is at the document's foot, and the pane
 * scrolled that much past it to the widget. In a box at the element's
 * corner, the widget is laid out where it was.
 */
function atViewport(
  fixed: boolean,
  key: string,
  node: ReactElement,
): ReactElement {
  if (!fixed) return node;
  return placed(AT_VIEWPORT as Style['position'], key, node);
}

/**
 * What is mounted for a control, kept with the box it is drawn in: at the
 * viewport (`atViewport`), or, in a sticky box the viewport keeps
 * (`ControlRect.held`), as far from where the flow has it as the box is
 * held. Mounted at its rect beside the element and told again as it was
 * painted, MDN's filter over its sticky sidebar was drawn a step of the
 * scroll up from the box around it at every frame of one, and put back at
 * the next.
 */
function keptWithBox(
  rect: ControlRect | undefined,
  key: string,
  node: ReactElement,
): ReactElement {
  if (!rect?.held) return atViewport(rect?.atViewport === true, key, node);
  return placed(heldPosition(rect.element, false), key, node);
}

/**
 * What is mounted for an embedded element or a video, kept with the box it
 * is drawn in, as a control's widget is. Always in these two boxes, with
 * only the position changing: a page that stops a box being sticky at a
 * breakpoint, or makes it fixed, does not make this another node, which
 * would be a new document in an `<iframe>`, its scripts started again, and
 * a video playing from its start. Where nothing moves it, the box is
 * where the mount is, and nothing is placed.
 */
export function keptMount(
  rect: { element: Element; atViewport?: true; held?: true },
  key: string,
  ...nodes: ReactNode[]
): ReactElement {
  const position = rect.held
    ? heldPosition(rect.element, true)
    : rect.atViewport
      ? (AT_VIEWPORT as Style['position'])
      : 'relative';
  return placed(position, key, ...nodes);
}

/** The position that keeps a mount with its sticky box. `drawn` says it is
 *  placed where the document draws its element, which a scale around the
 *  box moves, as a frame or a player is, where a widget goes where its box
 *  was laid out. One object for an element, since a new one at each render
 *  of the document would be a new style for the box it is in. */
function heldPosition(element: Element, drawn: boolean): Style['position'] {
  let position = HELD_POSITIONS.get(element);
  if (!position) {
    position = {
      name: HELD_AT_VIEWPORT,
      element,
      drawn,
    } as unknown as Style['position'];
    HELD_POSITIONS.set(element, position);
  }
  return position;
}

const HELD_POSITIONS = new WeakMap<Element, Style['position']>();

/** A box of no size at the element's corner, in a position core does not
 *  name, registered by `registerHtmlView`; `Style` takes one only where an
 *  app's declarations add it. */
function placed(
  position: Style['position'],
  key: string,
  ...nodes: ReactNode[]
): ReactElement {
  return hx(
    'box',
    { key, selectable: false, style: CORNER },
    hx(
      'box',
      {
        selectable: false,
        style: { position, width: 0, height: 0 },
      },
      ...nodes,
    ),
  );
}

const CORNER: Style = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: 0,
  height: 0,
};

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
  const control = rects.find((r) => r.element === invalid.element);
  const rect = control ?? view?.elementRect(invalid.element) ?? null;
  if (!rect) return null;
  const message = hx(
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
  // under a field in a fixed or a sticky header, where the header is drawn
  return keptWithBox(control, 'form-message', message);
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
 * than the theme's — its glyphs' fill, where `-webkit-text-fill-color` sets
 * one. Its face and size are the frame's, as every field's are.
 */
function bareField(bare: BareField): Style {
  return {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
    paddingLeft: 0,
    paddingRight: 0,
    color: bare.fill ?? bare.color,
    // a text area's lines as far apart as the page's (react-x11 2.56.1)
    ...(bare.lineHeight !== undefined && { lineHeight: bare.lineHeight }),
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
 *  no other: what that did to them. */
function setSelectedOption(el: Element, value: string): HtmlChange[] {
  let found = false;
  const changes: HtmlChange[] = [];
  for (const option of optionElements(el)) {
    const oldValue = attr(option, 'selected') ?? null;
    if (!found && optionValue(option) === value) {
      option.attribs.selected = '';
      found = true;
    } else {
      delete option.attribs.selected;
    }
    if ((attr(option, 'selected') ?? null) !== oldValue) {
      changes.push({
        type: 'attributes',
        target: option,
        attributeName: 'selected',
        oldValue,
      });
    }
  }
  return changes;
}

/** Whether a control is a text field: one whose value is what is typed,
 *  and whose `change` is when it is left (HTML 4.10.5.5). */
function isTextField(el: Element): boolean {
  const tag = tagOf(el);
  if (tag === 'textarea') return true;
  return (
    tag === 'input' && buttonType(el) === null && !CHECKABLE.has(inputType(el))
  );
}

const CHECKABLE = new Set(['checkbox', 'radio', 'hidden', 'file', 'image']);

/** A control's value as a script reads it (`Forms.value`). */
function controlState(el: Element, forms: FormState): string | boolean | null {
  const tag = tagOf(el);
  if (tag === 'select') return selectedOption(el) ?? '';
  if (tag === 'textarea') return forms.value(el);
  if (tag !== 'input') return null;
  const type = inputType(el);
  if (type === 'checkbox' || type === 'radio') {
    return attr(el, 'checked') !== undefined;
  }
  return forms.value(el);
}

/**
 * A field's selection API: core's `selectionStart`, `selectionEnd`,
 * `selectionDirection` and `setSelectionRange()` on `<textinput>` and
 * `<textarea>` (react-x11#1006), in UTF-16 code units as HTML's are. Asked
 * at run time, so a core without it still mounts a field: one that shows
 * nothing a script selects, whose selection is what `FormState` kept.
 */
interface SelectingField {
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly selectionDirection: string;
  setSelectionRange(
    start: number,
    end: number,
    direction?: FieldSelection['direction'],
  ): void;
}

/** Whether core's `<Select>` takes `open` and tells `onOpenChange`, as
 *  learnt from the first trigger seen; null before one is. */
let selectsHoldOpen: boolean | null = null;

/**
 * Whether core's `<Select>` holds its menu as its owner says (react-x11
 * with `open` and `onOpenChange` on the select): one that does not passes
 * both on to its trigger's box with the rest of its props, so a trigger
 * that has an `onOpenChange` of its own is a select's that took none.
 * Every select is the same core's, so what one trigger says is kept for
 * the next asked before its widget is mounted.
 */
function holdsOpen(trigger: DrawnNode | null): boolean | null {
  if (trigger) {
    const props = (trigger as unknown as { props: Record<string, unknown> })
      .props;
    selectsHoldOpen = !('onOpenChange' in props);
  }
  return selectsHoldOpen;
}

function selectingField(node: TextInputNode | null): SelectingField | null {
  const field = node as (TextInputNode & Partial<SelectingField>) | null;
  return typeof field?.setSelectionRange === 'function'
    ? (field as SelectingField)
    : null;
}

function selectionOf(field: SelectingField): FieldSelection {
  const direction = field.selectionDirection;
  return {
    start: field.selectionStart,
    end: field.selectionEnd,
    direction:
      direction === 'forward' || direction === 'backward' ? direction : 'none',
  };
}

/** An offset a host hands in, as a whole number from 0 to `limit`. */
function clampOffset(offset: number, limit: number): number {
  const n = Math.trunc(offset);
  return Number.isNaN(n) ? 0 : Math.min(Math.max(0, n), limit);
}
