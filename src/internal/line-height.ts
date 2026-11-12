// What a `lineHeight` style multiplies by. Shared by `<richtext>` and
// `<CodeEditor>`, which both lay text out against the font's own line.

/**
 * A `lineHeight` a layout can multiply by, or undefined for the font's own:
 * core's `lineHeightOf`, which its exports map does not carry. The style's
 * type takes `'150%'`, `'24px'` and `'normal'` as well, and a layout handed
 * one of those sets a paragraph NaN pixels tall, so anything but a number or
 * a numeric string is the font's own here, as it is at core's call.
 */
export function lineHeightOf(value: unknown): number | undefined {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && NUMERIC.test(value)
        ? Number(value)
        : NaN;
  return n >= 0 && n < Infinity ? n : undefined;
}

const NUMERIC = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?\s*$/i;
