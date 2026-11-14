// `text-indent`'s value as its parts (CSS Text 3, 7.1), for the cascade and
// for `el.style`, which both read it: a module of its own, since `style.ts`
// imports `specified.ts`.
import { splitValue } from './values.js';

/**
 * `text-indent`'s parts (CSS Text 3, 7.1): one length or percentage, and
 * `hanging` and `each-line` each at most once, in any order. Null for
 * anything else.
 */
export function textIndentParts(
  value: string,
): { length: string; hanging: boolean; eachLine: boolean } | null {
  let length: string | null = null;
  let hanging = false;
  let eachLine = false;
  for (const part of splitValue(value.trim())) {
    const word = part.toLowerCase();
    if (word === 'hanging') {
      if (hanging) return null;
      hanging = true;
    } else if (word === 'each-line') {
      if (eachLine) return null;
      eachLine = true;
    } else if (length === null) length = part;
    else return null;
  }
  return length === null ? null : { length, hanging, eachLine };
}
