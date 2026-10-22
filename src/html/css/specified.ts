// A declaration's value as `el.style` keeps it (CSSOM 6.7, "set a CSS
// declaration"): parsed against the property's grammar, and kept in its
// canonical form, or not kept at all where it is no value of the property.
// Only the properties this engine reads a grammar for answer; any other is
// kept as it was written, as it always was here, so a value a page sets and
// reads back is never lost to a grammar this has not got.

import { parseShapeFunction } from './shape-function.js';
import { splitValue } from './values.js';
import type { UnitContext } from './values.js';

/** What a value is read against where it is only checked: its lengths
 *  are any lengths. */
const CHECK: UnitContext = { em: 16, rem: 16, vw: 1, vh: 1, scale: 1 };

const GEOMETRY_BOXES =
  /^(margin-box|border-box|padding-box|content-box|fill-box|stroke-box|view-box)$/i;

/**
 * `prop`'s value `value` as a declaration keeps it: its canonical text, or
 * null for a value the property does not take — which leaves the
 * declaration as it was — and undefined where this has no grammar for it.
 */
export function specifiedValue(
  prop: string,
  value: string,
): string | null | undefined {
  // a value that is only known once it is substituted, or a keyword
  // every property takes, is kept as written
  if (/\b(?:var|env|attr)\(/i.test(value)) return undefined;
  const name = prop.toLowerCase();
  if (name === 'clip-path' || name === '-webkit-clip-path') {
    if (!/\bshape\(/i.test(value)) return undefined;
    // a shape, and a box beside it or none, in either order
    const parts = splitValue(value.trim());
    let shape: string | null = null;
    let box: string | null = null;
    for (const part of parts) {
      if (GEOMETRY_BOXES.test(part)) {
        if (box) return null;
        box = part.toLowerCase();
      } else {
        if (shape) return null;
        shape = parseShapeFunction(part, CHECK)?.text ?? null;
        if (!shape) return null;
      }
    }
    if (!shape) return null;
    return box ? `${shape} ${box}` : shape;
  }
  return undefined;
}
