/**
 * `target.splice(from, removed, ...items)`, for any number of items.
 *
 * A spread argument list lives on the stack, and somewhere past a hundred
 * thousand items it throws `RangeError: Maximum call stack size exceeded` —
 * a pasted log, or a file replaced whole, is that many lines. Past a few
 * thousand the array is rebuilt in place instead: whoever holds `target`
 * keeps holding it, which is the whole reason it is spliced rather than
 * replaced.
 */
export function spliceAll<T>(
  target: T[],
  from: number,
  removed: number,
  items: readonly T[],
): void {
  if (items.length <= 4096) {
    target.splice(from, removed, ...items);
    return;
  }
  const tail = target.slice(from + removed);
  target.length = from;
  for (let i = 0; i < items.length; i++) target.push(items[i]);
  for (let i = 0; i < tail.length; i++) target.push(tail[i]);
}
