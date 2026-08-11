// Cross-block selection for `<Markdown>`. One document renders as many
// `<richtext>` nodes (paragraphs, list lines, cells); this controller is the
// thing that makes them feel like one continuous text: it owns the
// anchor/focus pair, decides which node a pointer position belongs to, and
// pushes per-node [start, end) ranges down to the nodes that paint them.
//
// It lives outside React on purpose. A drag produces a mousemove per frame,
// and re-rendering the component tree per frame to move a highlight would
// be paying React's diff for a fill that two retained nodes already know
// how to repaint. The component wires events in (see index.ts); state
// changes go straight to `SelectableBlock.setSelection`, which damages only the
// node's own rect.
/**
 * What the controller needs a block to be. `RichTextNode` satisfies it, but
 * the controller never names the class: a structural interface keeps the
 * public `.d.ts` free of the (nominal) node type — and leaves the seam
 * open for a future block kind that is not an `<richtext>` at all (an MDX
 * component that wants its text selectable would implement this).
 */
export interface SelectableBlock {
  /** Document position, for ordering. */
  readonly order: number;
  /** Copy separator between this block and the previous selected one. */
  readonly joiner: string;
  /** Text length in code points. */
  readonly length: number;
  readonly destroyed: boolean;
  readonly abs: { x: number; y: number; width: number; height: number };
  /** Current highlight, [start, end) in code points; equal when none. */
  readonly selection: [number, number];
  text(from?: number, to?: number): string;
  indexAtPoint(x: number, y: number): number;
  wordRangeAt(index: number): [number, number];
  setSelection(a: number, b: number): void;
}

/** What `<Markdown>`'s blocks hand their nodes so they can be found. */
export interface SelectionRegistry {
  register(node: SelectableBlock): void;
  unregister(node: SelectableBlock): void;
}

/** A position in the document: a block, and a code-point index within it. */
interface Point {
  node: SelectableBlock;
  index: number;
}

type Granularity = 'char' | 'word' | 'block';

export class TextSelection implements SelectionRegistry {
  private nodes = new Set<SelectableBlock>();
  private sorted: SelectableBlock[] | null = null;
  private anchorFrom: Point | null = null; // the fixed end's range: word and
  private anchorTo: Point | null = null; //   block modes anchor a span, not a caret
  private focus: Point | null = null;
  private granularity: Granularity = 'char';
  private dragging = false;

  /** Fired when the highlighted range changes — the component hangs the
   *  PRIMARY-selection announcement off this. */
  onChange: ((hasSelection: boolean) => void) | null = null;

  register(node: SelectableBlock): void {
    this.nodes.add(node);
    this.sorted = null;
  }

  unregister(node: SelectableBlock): void {
    if (!this.nodes.delete(node)) return;
    this.sorted = null;
    // a block that unmounts mid-drag (streaming re-shapes the tail) takes
    // its end of the selection with it; drop the gesture rather than
    // holding a pointer to a dead node
    if (
      this.anchorFrom?.node === node ||
      this.focus?.node === node ||
      this.anchorTo?.node === node
    ) {
      this.anchorFrom = this.anchorTo = this.focus = null;
      this.dragging = false;
      this.apply();
    }
  }

  private ordered(): SelectableBlock[] {
    if (!this.sorted) {
      this.sorted = [...this.nodes]
        .filter((n) => !n.destroyed)
        .sort((a, b) => a.order - b.order);
    }
    return this.sorted;
  }

  /** The block a window-coordinate point selects into: the vertically
   *  containing block nearest horizontally, else the vertically nearest —
   *  so dragging through margins and past either end behaves like any
   *  text view. */
  private hit(x: number, y: number): Point | null {
    const nodes = this.ordered();
    let best: SelectableBlock | null = null;
    let bestScore = Infinity;
    for (const n of nodes) {
      const { x: nx, y: ny, width, height } = n.abs;
      const dy = y < ny ? ny - y : y >= ny + height ? y - (ny + height) + 1 : 0;
      const dx = x < nx ? nx - x : x >= nx + width ? x - (nx + width) + 1 : 0;
      // vertical distance dominates: a block on the same line of the page
      // wins over a nearer one in another row
      const score = dy * 4096 + dx;
      if (score < bestScore) {
        bestScore = score;
        best = n;
      }
    }
    if (!best) return null;
    return { node: best, index: best.indexAtPoint(x, y) };
  }

  private position(p: Point): number {
    // orders are sparse integers; pack (block, index) into one comparable
    return p.node.order * 2 ** 26 + Math.min(p.index, 2 ** 26 - 1);
  }

  /** Mouse down. `detail` is the click count — 2 selects the word, 3 the
   *  block, exactly as `<textinput>` counts them. */
  begin(x: number, y: number, detail: number): void {
    const p = this.hit(x, y);
    if (!p) {
      this.clear();
      return;
    }
    this.dragging = true;
    if (detail >= 3) {
      this.granularity = 'block';
      this.anchorFrom = { node: p.node, index: 0 };
      this.anchorTo = { node: p.node, index: p.node.length };
    } else if (detail === 2) {
      this.granularity = 'word';
      const [a, b] = p.node.wordRangeAt(p.index);
      this.anchorFrom = { node: p.node, index: a };
      this.anchorTo = { node: p.node, index: b };
    } else {
      this.granularity = 'char';
      this.anchorFrom = this.anchorTo = p;
    }
    this.focus = null;
    this.apply();
  }

  /** Mouse move while the button is down. */
  extend(x: number, y: number): void {
    if (!this.dragging || !this.anchorFrom) return;
    const p = this.hit(x, y);
    if (!p) return;
    this.focus = p;
    this.apply();
  }

  /** Mouse up. True if a non-empty selection survived the gesture. */
  end(): boolean {
    this.dragging = false;
    return this.hasSelection();
  }

  selectAll(): void {
    const nodes = this.ordered();
    if (nodes.length === 0) return;
    this.granularity = 'char';
    this.anchorFrom = this.anchorTo = { node: nodes[0], index: 0 };
    const last = nodes[nodes.length - 1];
    this.focus = { node: last, index: last.length };
    this.dragging = false;
    this.apply();
  }

  clear(): void {
    this.anchorFrom = this.anchorTo = this.focus = null;
    this.dragging = false;
    this.apply();
  }

  hasSelection(): boolean {
    for (const n of this.ordered()) {
      const [a, b] = n.selection;
      if (b > a) return true;
    }
    return false;
  }

  /** The highlighted text, blocks joined by each block's own separator —
   *  newlines between list lines, tabs between the cells of a row. */
  text(): string {
    const parts: string[] = [];
    for (const n of this.ordered()) {
      const [a, b] = n.selection;
      if (b <= a) continue;
      if (parts.length > 0) parts.push(n.joiner);
      parts.push(n.text(a, b));
    }
    return parts.join('');
  }

  /** Recompute every node's range from anchor/focus and push the deltas. */
  private apply(): void {
    // The selection is the span of a few candidate points: both ends of
    // the anchored range, plus the focus — widened to its word or block in
    // those modes, which is what makes a word-drag swallow whole words on
    // either side, the way every text view does it.
    const pts: Point[] = [];
    if (
      this.anchorFrom &&
      this.anchorTo &&
      !this.anchorFrom.node.destroyed &&
      !this.anchorTo.node.destroyed
    ) {
      pts.push(this.anchorFrom, this.anchorTo);
      const focus =
        this.focus && !this.focus.node.destroyed ? this.focus : null;
      if (focus) {
        if (this.granularity === 'word') {
          const [a, b] = focus.node.wordRangeAt(focus.index);
          pts.push(
            { node: focus.node, index: a },
            { node: focus.node, index: b },
          );
        } else if (this.granularity === 'block') {
          pts.push(
            { node: focus.node, index: 0 },
            { node: focus.node, index: focus.node.length },
          );
        } else {
          pts.push(focus);
        }
      }
    }

    let startPos = 0;
    let endPos = 0;
    for (const p of pts) {
      const pos = this.position(p);
      if (pts[0] === p || pos < startPos) startPos = pos;
      if (pts[0] === p || pos > endPos) endPos = pos;
    }

    for (const n of this.ordered()) {
      if (endPos <= startPos) {
        n.setSelection(0, 0);
        continue;
      }
      const nStart = n.order * 2 ** 26;
      const a = Math.max(startPos, nStart);
      const b = Math.min(endPos, nStart + n.length);
      if (b <= a) n.setSelection(0, 0);
      else n.setSelection(a - nStart, b - nStart);
    }
    this.onChange?.(endPos > startPos);
  }
}
