// Image maps (HTML 4.8.14): which `<area>` of the `<map>` an `<img usemap>`
// names holds a point of the image, which is what a pointer over the image is
// over. Pure, and over the document's tree alone.
import { attr, isElement, tagOf } from './dom.js';
import type { AnyNode, Document, Element } from './dom.js';

/** The `<map>` a `usemap` names in a tree: its `name` (HTML 4.8.14, "rules
 *  for parsing a hash-name reference"). */
function mapNamed(root: AnyNode, name: string): Element | null {
  const stack: AnyNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (isElement(node) && tagOf(node) === 'map') {
      if (attr(node, 'name') === name || attr(node, 'id') === name) return node;
    }
    const kids = (node as { children?: readonly AnyNode[] }).children;
    if (kids) for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return null;
}

/** An area's numbers, as HTML's "rules for parsing a list of floats" reads
 *  them: anything but a number or a sign is a separator. */
function coordsOf(el: Element): number[] {
  const out: number[] = [];
  for (const part of (attr(el, 'coords') ?? '').split(/[^\d.eE+-]+/)) {
    if (!part) continue;
    const n = parseFloat(part);
    out.push(Number.isFinite(n) ? n : 0);
  }
  return out;
}

/** Whether a point is in an area's shape (HTML 4.8.15.1): an area with no
 *  usable coordinates has no shape, and so takes no point. */
function holds(el: Element, x: number, y: number): boolean {
  const c = coordsOf(el);
  const shape = (attr(el, 'shape') ?? 'rect').toLowerCase();
  if (shape === 'default') return true;
  if (shape === 'circle' || shape === 'circ') {
    if (c.length < 3 || c[2] <= 0) return false;
    return Math.hypot(x - c[0], y - c[1]) <= c[2];
  }
  if (shape === 'poly' || shape === 'polygon') {
    if (c.length < 6) return false;
    let inside = false;
    const n = c.length - (c.length % 2);
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const [xi, yi, xj, yj] = [c[i], c[i + 1], c[j], c[j + 1]];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }
  if (c.length < 4) return false;
  const [left, right] = c[0] < c[2] ? [c[0], c[2]] : [c[2], c[0]];
  const [top, bottom] = c[1] < c[3] ? [c[1], c[3]] : [c[3], c[1]];
  return x >= left && x < right && y >= top && y < bottom;
}

/** The first `<area>` in tree order under a point of an image, in CSS pixels
 *  from its corner, where the image names a map; `undefined` where it names
 *  none, and null where the map takes no point there. */
export function areaAt(
  img: Element,
  doc: Document | null,
  x: number,
  y: number,
): Element | null | undefined {
  const use = attr(img, 'usemap');
  if (!use?.startsWith('#') || !doc) return undefined;
  const map = mapNamed(doc, use.slice(1));
  if (!map) return undefined;
  const stack: AnyNode[] = [...map.children].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (!isElement(node)) continue;
    if (tagOf(node) === 'area' && holds(node, x, y)) return node;
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      stack.push(node.children[i]);
    }
  }
  return null;
}
