// Floats, as the only thing the rest of layout has to know about them: how
// wide the line is at a given height, and how far down `clear` has to go.
//
// A float is the one construct in block layout that reaches sideways — it is
// placed by one block and shortens the lines of the *next* ones — so it is
// held per block formatting context rather than per box, which is what the
// spec means by "a float is contained by its BFC". Everything else in
// `block.ts` can then be written as if floats did not exist, and asks here
// only where it has to.
//
// Coordinates are the BFC's own: `x` from its content-box left edge, `y`
// growing down from its content-box top.

export interface FloatBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  side: 'left' | 'right';
}

/** The horizontal band available at a height. */
export interface Band {
  left: number;
  right: number;
}

/**
 * How much narrower than a float its room may be and still hold it: the
 * error of adding up widths, which are fractions of a pixel. Ten floats of
 * `0.87em` in a box `8.7em` wide came to more than the box by 1e-14 px,
 * and the tenth went under the other nine.
 */
const FIT_SLACK = 1e-6;

export class FloatContext {
  private _boxes: FloatBox[] = [];
  private _lowestLeft = -Infinity;
  private _lowestRight = -Infinity;
  /** The top of the float placed last, which no later one goes above. */
  private _lastTop = -Infinity;
  /** The BFC's own content edges, which is what a band is clipped to. */
  readonly left: number;
  readonly right: number;

  constructor(left: number, right: number) {
    this.left = left;
    this.right = right;
  }

  get isEmpty(): boolean {
    return this._boxes.length === 0;
  }

  /** How many floats are placed: a mark for `clearanceSince`. */
  get count(): number {
    return this._boxes.length;
  }

  add(box: FloatBox): void {
    this._boxes.push(box);
    if (box.top > this._lastTop) this._lastTop = box.top;
    if (box.side === 'left')
      this._lowestLeft = Math.max(this._lowestLeft, box.bottom);
    else this._lowestRight = Math.max(this._lowestRight, box.bottom);
  }

  /**
   * The band left for a line of `height` starting at `y`, between `left`
   * and `right` — the formatting context's own edges unless a narrower
   * containing block is asking.
   *
   * A float intersects a line when their vertical ranges overlap at all —
   * not when the line's top is inside the float — which is why this takes a
   * height rather than just a position. Getting that wrong lets the last
   * line of a wrapped paragraph slide under a floated image by a pixel.
   *
   * `solid` leaves out a float of no width: a block with a formatting
   * context of its own may not overlap a float's margin box (CSS 2.1 9.5),
   * and one with no area has nothing to overlap, wherever it is.
   */
  bandAt(
    y: number,
    height: number,
    left = this.left,
    right = this.right,
    solid = false,
  ): Band {
    const bottom = y + Math.max(1, height);
    for (const box of this._boxes) {
      if (box.bottom <= y || box.top >= bottom) continue;
      if (solid && box.right <= box.left) continue;
      if (box.side === 'left') left = Math.max(left, box.right);
      else right = Math.min(right, box.left);
    }
    return { left, right: Math.max(left, right) };
  }

  /** Whether any float overlaps a vertical range at all. The inline layout
   *  asks this to decide between one text layout and one per line. */
  intersects(from: number, to: number): boolean {
    for (const box of this._boxes) {
      if (box.bottom > from && box.top < to) return true;
    }
    return false;
  }

  /**
   * Where a line at `y`, `height` tall, next has more room: the nearest
   * bottom edge of a float beside it. Null when no float is, so nothing
   * below can widen the line.
   */
  nextEdgeBelow(y: number, height: number): number | null {
    const bottom = y + Math.max(1, height);
    let next: number | null = null;
    for (const box of this._boxes) {
      if (box.bottom <= y || box.top >= bottom) continue;
      if (next === null || box.bottom < next) next = box.bottom;
    }
    return next;
  }

  /**
   * The lowest `y` a box with this `clear` may start at. `-Infinity` when
   * nothing is in the way, so a caller takes `Math.max(y, clearance)`.
   */
  clearance(clear: 'none' | 'left' | 'right' | 'both'): number {
    switch (clear) {
      case 'left':
        return this._lowestLeft;
      case 'right':
        return this._lowestRight;
      case 'both':
        return Math.max(this._lowestLeft, this._lowestRight);
      default:
        return -Infinity;
    }
  }

  /** `clearance`, of the floats placed since `mark` alone. */
  clearanceSince(
    clear: 'none' | 'left' | 'right' | 'both',
    mark: number,
  ): number {
    if (clear === 'none') return -Infinity;
    let lowest = -Infinity;
    for (let i = mark; i < this._boxes.length; i += 1) {
      const float = this._boxes[i];
      if (clear === 'both' || clear === float.side) {
        lowest = Math.max(lowest, float.bottom);
      }
    }
    return lowest;
  }

  /** Move the floats placed since `mark` down by `dy`, with the block they
   *  were placed in: a list item's first block goes lower to make room
   *  for its marker once it is laid out (`layoutChildren`). */
  moveSince(mark: number, dy: number): void {
    if (!dy || mark >= this._boxes.length) return;
    for (let i = mark; i < this._boxes.length; i += 1) {
      const float = this._boxes[i];
      this._boxes[i] = {
        ...float,
        top: float.top + dy,
        bottom: float.bottom + dy,
      };
    }
    this._lowestLeft = -Infinity;
    this._lowestRight = -Infinity;
    this._lastTop = -Infinity;
    for (const float of this._boxes) {
      if (float.top > this._lastTop) this._lastTop = float.top;
      if (float.side === 'left')
        this._lowestLeft = Math.max(this._lowestLeft, float.bottom);
      else this._lowestRight = Math.max(this._lowestRight, float.bottom);
    }
  }

  /** How far down the floats reach — what a container that establishes a
   *  BFC has to grow to, so it does not end above its own floats. */
  get bottom(): number {
    return Math.max(this._lowestLeft, this._lowestRight);
  }

  /**
   * The first `y` at or below `from` where a box `width` wide fits on `side`
   * between `left` and `right`, its containing block's content edges. A
   * float that does not fit beside the ones already placed goes under them,
   * which is the rule that makes two 60%-wide floats stack; one wider than
   * its containing block goes where nothing is beside it.
   *
   * No higher than the float placed before it, either (CSS 2.1 9.5.1, rule
   * 5): a float that fits in a gap an earlier one went under does not go
   * back up into it. That also makes every float already placed start at or
   * above the one being placed, so the band only widens below its top and a
   * band one pixel tall there is the band over its whole height. And it is
   * what keeps a row of floats cheap: from the top of the one before, the
   * floats of the rows above are no candidates at all, where a thousand
   * floated thumbnails walked the bottoms of every row above theirs.
   */
  placeAt(
    from: number,
    width: number,
    side: 'left' | 'right',
    left = this.left,
    right = this.right,
  ): number {
    if (from < this._lastTop) from = this._lastTop;
    // where it fits at once, as most do, nothing below is looked at
    if (this._fits(from, width, side, left, right)) return from;
    // Candidate positions are the bottom of every float below `from`; there
    // is no other height at which the band can get wider.
    const candidates: number[] = [];
    for (const box of this._boxes) {
      if (box.bottom > from) candidates.push(box.bottom);
    }
    candidates.sort((a, b) => a - b);
    let y = from;
    for (const candidate of candidates) {
      // a row of floats ends at one height, asked about once
      if (candidate === y) continue;
      if (this._fits(candidate, width, side, left, right)) return candidate;
      y = candidate;
    }
    return y;
  }

  /**
   * Whether a float `width` wide fits at `y` (CSS 2.1 9.5.1): past the
   * floats on its own side, and short of every float on the other (rule
   * 3), which lets it stand out of its containing block where no float of
   * its own side is beside it, and within the containing block where one
   * is (rule 7). Held to the containing block always, a float wider than
   * its block went below every float beside it, where it fitted beside
   * them in the formatting context.
   */
  private _fits(
    y: number,
    width: number,
    side: 'left' | 'right',
    left: number,
    right: number,
  ): boolean {
    const start = side === 'left';
    let near = start ? left : right;
    let far = start ? Infinity : -Infinity;
    let beside = false;
    for (const box of this._boxes) {
      if (box.bottom <= y || box.top >= y + 1) continue;
      if (box.side === side) {
        beside = true;
        near = start ? Math.max(near, box.right) : Math.min(near, box.left);
      } else {
        far = start ? Math.min(far, box.left) : Math.max(far, box.right);
      }
    }
    if (beside) far = start ? Math.min(far, right) : Math.max(far, left);
    return start
      ? near + width <= far + FIT_SLACK
      : near - width >= far - FIT_SLACK;
  }
}
