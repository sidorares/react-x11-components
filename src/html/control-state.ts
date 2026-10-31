// What a selector asks of a form control, one answer for a stylesheet and a
// page's `matches()`: each compiles these (`Cascade`, `DomHost._selectOptions`)
// and a page that styles a field by `:invalid` and reads `matches(':invalid')`
// cannot hear two things. The pure half is `form.ts`.
import type { Element } from 'domhandler';

import { hasCustomState } from './dom.js';
import { directionOf } from './direction.js';
import {
  isDefault,
  isInRange,
  isIndeterminate,
  isInvalid,
  isOutOfRange,
  isReadOnly,
  isReadWrite,
  isUserInvalid,
  isUserValid,
  isValid,
  placeholderShown,
} from './form.js';

/**
 * css-select's `aliases` come before a function of the same name, so a
 * pseudo-class it has an alias for is taken over by a string naming a
 * function of ours: its `:read-only` and `:read-write` are text fields'
 * alone, and need a `type` written out.
 *
 * `:blank` and `:local-link` are not here, and a rule that names one is
 * dropped: Chromium, Firefox and WebKit all refuse them, so a page that
 * writes either has written it for no browser.
 */
export const CONTROL_PSEUDOS = {
  valid: (el: Element) => isValid(el),
  invalid: (el: Element) => isInvalid(el),
  'user-valid': (el: Element) => isUserValid(el),
  'user-invalid': (el: Element) => isUserInvalid(el),
  'in-range': (el: Element) => isInRange(el),
  'out-of-range': (el: Element) => isOutOfRange(el),
  'placeholder-shown': (el: Element) => placeholderShown(el),
  indeterminate: (el: Element) => isIndeterminate(el),
  default: (el: Element) => isDefault(el),
  'read-only': ':-rx-read-only',
  'read-write': ':-rx-read-write',
  '-rx-read-only': (el: Element) => isReadOnly(el),
  '-rx-read-write': (el: Element) => isReadWrite(el),
  // nothing here fills a form in
  autofill: (_el: Element) => false,
  '-webkit-autofill': (_el: Element) => false,
  // case-sensitive, as a custom element's states are, and its argument
  // one identifier (`argumentFits`); a direction's is ASCII case-insensitive
  state: (el: Element, name?: string | null) =>
    hasCustomState(el, (name ?? '').trim()),
  dir: (el: Element, direction?: string | null) =>
    directionOf(el) === (direction ?? '').trim().toLowerCase(),
};

/**
 * What a rule can read of a field that what it holds decides, in a number
 * to compare: a keystroke tells the cascade only where this moves, since a
 * refresh per keystroke would restyle for what changed no answer. Direction
 * too, a field with `dir=auto` taking it from its text.
 */
export function controlAnswers(el: Element): number {
  return (
    (isValid(el) ? 1 : 0) |
    (isInRange(el) ? 2 : 0) |
    (isOutOfRange(el) ? 4 : 0) |
    (placeholderShown(el) ? 8 : 0) |
    (directionOf(el) === 'rtl' ? 16 : 0)
  );
}
