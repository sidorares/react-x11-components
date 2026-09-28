// Text compared the way `String#localeCompare` with no locale compares it,
// with one collator for every comparison. ECMA-402 defines that call as a
// new `Intl.Collator()`'s `compare`, and V8 made the collator on every call:
// most of a 100,000-row table sort, and all of a completion list's with
// nothing typed yet. Made on first use, so importing constructs nothing.

let collator: Intl.Collator | null = null;

/** `a.localeCompare(b)`, without a collator a call. */
export function compareText(a: string, b: string): number {
  return (collator ??= new Intl.Collator()).compare(a, b);
}
