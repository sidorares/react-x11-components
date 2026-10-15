// Where a link, a form or `window.open` sends what it asks for (HTML
// 7.3.1.7, the rules for choosing a navigable): the tab the page is in, a
// new one, or one of the page's frames — the one its name names. A page's
// tracking pixel posts into a hidden frame it names as the form's target,
// and the tab went with it.
import * as DomUtils from 'domutils';
import type { Document, Element } from 'domhandler';

/** Where a target sends a navigation: the page's own tab, a new tab, or
 *  the frame element whose navigable it is. */
export type Navigable = 'here' | 'tab' | Element;

/** The elements whose navigable a name may choose. */
const FRAMES = new Set(['iframe', 'frame', 'object']);

/**
 * The navigable a target names, from a document in a tab of its own: its
 * keywords ASCII case-insensitively — `_parent` and `_top` are the tab,
 * since the page is the top of it — and else the first frame in tree order
 * with that name. A name nothing has is a new tab, which HTML would give
 * that name; this browser names no tab, so a second link to it opens
 * another.
 */
export function navigableFor(
  document: Document | null,
  target: string,
): Navigable {
  const keyword = target.toLowerCase();
  if (
    keyword === '' ||
    keyword === '_self' ||
    keyword === '_parent' ||
    keyword === '_top'
  ) {
    return 'here';
  }
  if (keyword === '_blank' || !document) return 'tab';
  return (
    DomUtils.findOne(
      (el) => FRAMES.has(el.name) && el.attribs.name === target,
      document.children,
      true,
    ) ?? 'tab'
  );
}

/** A link's target (HTML 4.6.5, "get an element's target"): its own
 *  `target`, else the document's first `<base target>`. */
export function linkTarget(
  link: Element | null,
  document: Document | null,
): string {
  const own = link?.attribs.target;
  if (own !== undefined) return own;
  const base =
    document &&
    DomUtils.findOne(
      (el) => el.name === 'base' && el.attribs.target !== undefined,
      document.children,
      true,
    );
  return base?.attribs.target ?? '';
}
