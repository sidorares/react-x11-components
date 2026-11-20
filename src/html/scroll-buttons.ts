/**
 * Which of an element's `::scroll-button()`s are enabled (CSS Overflow 5,
 * 4): a button is enabled where its element is a scroll container that can
 * scroll in its direction from where it is, and disabled otherwise, a box
 * that does not scroll among them. Kept by element at module scope, as a
 * control's state is (`form.ts`), since a cascade has no element view; the
 * view works it out after each layout and each scroll and tells a change as
 * one of `-rx-scroll-buttons`, an attribute nothing has.
 */

import type { Element } from 'domhandler';

/** A direction's bit, in the order the buttons are made. */
export const SCROLL_BUTTON_BITS: Readonly<Record<string, number>> = {
  'block-start': 1,
  'inline-start': 2,
  'inline-end': 4,
  'block-end': 8,
};

const ENABLED = new WeakMap<Element, number>();

/** Whether an element's button for a direction is enabled. */
export function scrollButtonEnabled(el: Element, direction: string): boolean {
  return ((ENABLED.get(el) ?? 0) & (SCROLL_BUTTON_BITS[direction] ?? 0)) !== 0;
}

/** Set which of an element's buttons are enabled, as bits; whether that
 *  changed anything. */
export function setScrollButtonsEnabled(el: Element, bits: number): boolean {
  if ((ENABLED.get(el) ?? 0) === bits) return false;
  if (bits) ENABLED.set(el, bits);
  else ENABLED.delete(el);
  return true;
}
