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

export class FloatContext {
  private _boxes: FloatBox[] = [];
  private _lowestLeft = -Infinity;
  private _lowestRight = -Infinity;
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

  add(box: FloatBox): void {
    this._boxes.push(box);
    if (box.side === 'left')
      this._lowestLeft = Math.max(this._lowestLeft, box.bottom);
    else this._lowestRight = Math.max(this._lowestRight, box.bottom);
  }

  /**
   * The band left for a line of `height` starting at `y`.
   *
   * A float intersects a line when their vertical ranges overlap at all —
   * not when the line's top is inside the float — which is why this takes a
   * height rather than just a position. Getting that wrong lets the last
   * line of a wrapped paragraph slide under a floated image by a pixel.
   */
  bandAt(y: number, height: number): Band {
    let left = this.left;
    let right = this.right;
    const bottom = y + Math.max(1, height);
    for (const box of this._boxes) {
      if (box.bottom <= y || box.top >= bottom) continue;
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

  /** How far down the floats reach — what a container that establishes a
   *  BFC has to grow to, so it does not end above its own floats. */
  get bottom(): number {
    return Math.max(this._lowestLeft, this._lowestRight);
  }

  /**
   * The first `y` at or below `from` where a box `width` wide fits on `side`.
   * A float that does not fit beside the ones already placed goes under
   * them, which is the rule that makes two 60%-wide floats stack.
   */
  placeAt(from: number, width: number, side: 'left' | 'right'): number {
    let y = from;
    // Candidate positions are `from` and the bottom of every float below it;
    // there is no other height at which the band can get wider.
    const candidates = [from];
    for (const box of this._boxes) {
      if (box.bottom > from) candidates.push(box.bottom);
    }
    candidates.sort((a, b) => a - b);
    for (const candidate of candidates) {
      const band = this.bandAt(candidate, 1);
      if (band.right - band.left >= width) return candidate;
      y = candidate;
    }
    return y;
  }
}
