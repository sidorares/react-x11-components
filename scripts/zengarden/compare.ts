// What two captures of a page disagree about.
//
// **Boxes first.** Every element both engines laid out is compared by its
// offset from its nearest ancestor both laid out, and by its size. An
// element that moved moves everything in it, so an absolute comparison
// reports the whole subtree; a relative one reports the element that moved
// — which is where the cause is. Findings come in document order, so the
// first one is the outermost.
//
// **Pixels second, and coarsely.** Two text engines never agree on an
// antialiased edge, so the pages are compared in blocks, by their average
// colour: what a block that differs says is a background, an image or a
// box that is not where the other engine drew it.
import type { Image, Rect } from './chrome.js';

export interface Finding {
  path: string;
  kind: 'offset' | 'size' | 'only-chrome' | 'only-ours';
  chrome?: Rect;
  ours?: Rect;
  /** The disagreement, in pixels, as a short phrase. */
  delta: string;
}

export interface Tolerance {
  /** Pixels an offset may differ by. */
  offset: number;
  /** Pixels a size may differ by, or this fraction of it, whichever is
   *  more: a paragraph's width is set by its text, which two engines
   *  measure a hair apart. */
  size: number;
  sizeFraction: number;
}

export const DEFAULT_TOLERANCE: Tolerance = {
  offset: 3,
  size: 3,
  sizeFraction: 0.02,
};

const round = (n: number) => Math.round(n * 10) / 10;
const show = (r: Rect) =>
  `${round(r.x)},${round(r.y)} ${round(r.width)}×${round(r.height)}`;

/** Findings in the order of `order` — our document's. */
export function compareBoxes(
  chrome: Map<string, Rect>,
  ours: Map<string, Rect>,
  order: string[],
  tolerance: Tolerance = DEFAULT_TOLERANCE,
): Finding[] {
  const findings: Finding[] = [];
  const both = (path: string) => chrome.has(path) && ours.has(path);
  const parentOf = (path: string): string | null => {
    for (
      let at = path.lastIndexOf('/');
      at > 0;
      at = path.lastIndexOf('/', at - 1)
    ) {
      const up = path.slice(0, at);
      if (both(up)) return up;
    }
    return null;
  };
  const inHead = (path: string) => path.startsWith('/html[0]/head[0]');
  const seen = new Set<string>();
  const paths = [...order, ...chrome.keys()];
  for (const path of paths) {
    if (seen.has(path) || inHead(path)) continue;
    seen.add(path);
    const c = chrome.get(path);
    const o = ours.get(path);
    if (!c || !o) {
      const r = c ?? o!;
      if (r.width <= 0 || r.height <= 0) continue;
      findings.push({
        path,
        kind: c ? 'only-chrome' : 'only-ours',
        chrome: c,
        ours: o,
        delta: `${c ? 'Chrome' : 'ours'} only: ${show(r)}`,
      });
      continue;
    }
    const up = parentOf(path);
    const pc = up ? chrome.get(up)! : { x: 0, y: 0, height: 0 };
    const po = up ? ours.get(up)! : { x: 0, y: 0, height: 0 };
    const dx = c.x - pc.x - (o.x - po.x);
    // an inline element is its content area to Chrome and its line's band
    // to us: the same middle, a different top and height — so its middle
    // is compared, and measured from its parent's middle where that is
    // inline too
    const middleOf = (r: { y: number; height: number }, inline?: boolean) =>
      inline ? r.y + r.height / 2 : r.y;
    const parentInline = up ? chrome.get(up)!.inline : false;
    const dy = c.inline
      ? middleOf(c, true) -
        middleOf(pc, parentInline) -
        (middleOf(o, true) - middleOf(po, parentInline))
      : c.y - pc.y - (o.y - po.y);
    if (Math.abs(dx) > tolerance.offset || Math.abs(dy) > tolerance.offset) {
      findings.push({
        path,
        kind: 'offset',
        chrome: c,
        ours: o,
        delta: `offset from ${up ?? 'the page'} differs by ${round(dx)},${round(dy)} (Chrome ${show(c)}, ours ${show(o)})`,
      });
    }
    const allowW = Math.max(tolerance.size, c.width * tolerance.sizeFraction);
    const allowH = Math.max(tolerance.size, c.height * tolerance.sizeFraction);
    const dw = c.width - o.width;
    const dh = c.inline ? 0 : c.height - o.height;
    if (Math.abs(dw) > allowW || Math.abs(dh) > allowH) {
      findings.push({
        path,
        kind: 'size',
        chrome: c,
        ours: o,
        delta: `size differs by ${round(dw)}×${round(dh)} (Chrome ${show(c)}, ours ${show(o)})`,
      });
    }
  }
  return findings;
}

export interface VisualDiff {
  /** Blocks that differ, over the blocks compared. */
  fraction: number;
  /** Ours, faded, with the blocks that differ in red. */
  image: Image;
}

/** Block-average comparison over the height both images have. */
export function visualDiff(
  chrome: Image,
  ours: Image,
  { block = 8, threshold = 40 }: { block?: number; threshold?: number } = {},
): VisualDiff {
  const width = Math.min(chrome.width, ours.width);
  const height = Math.min(chrome.height, ours.height);
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const at = (Math.floor(i / width) * ours.width + (i % width)) * 4;
    for (let c = 0; c < 3; c += 1)
      out[i * 4 + c] = 128 + (ours.data[at + c] >> 1);
    out[i * 4 + 3] = 255;
  }
  let blocks = 0;
  let differing = 0;
  for (let by = 0; by < height; by += block) {
    for (let bx = 0; bx < width; bx += block) {
      const sum = [0, 0, 0, 0, 0, 0];
      let n = 0;
      for (let y = by; y < Math.min(by + block, height); y += 1) {
        for (let x = bx; x < Math.min(bx + block, width); x += 1) {
          const a = (y * chrome.width + x) * 4;
          const b = (y * ours.width + x) * 4;
          for (let c = 0; c < 3; c += 1) {
            sum[c] += chrome.data[a + c];
            sum[c + 3] += ours.data[b + c];
          }
          n += 1;
        }
      }
      blocks += 1;
      const d =
        (Math.abs(sum[0] - sum[3]) +
          Math.abs(sum[1] - sum[4]) +
          Math.abs(sum[2] - sum[5])) /
        (3 * n);
      if (d <= threshold) continue;
      differing += 1;
      for (let y = by; y < Math.min(by + block, height); y += 1) {
        for (let x = bx; x < Math.min(bx + block, width); x += 1) {
          const at = (y * width + x) * 4;
          out[at] = 255;
          out[at + 1] >>= 2;
          out[at + 2] >>= 2;
        }
      }
    }
  }
  return {
    fraction: blocks ? differing / blocks : 0,
    image: { width, height, data: out },
  };
}
