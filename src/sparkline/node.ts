// The retained node behind <sparkline>. `./index.ts` is the only module
// that imports this one, and it is also the module that registers the
// element — so the pair is reachable exactly when an app imports
// `Sparkline`, and droppable as a unit when it does not (see AGENTS.md,
// "Tree-shaking is a constraint, not a nice-to-have").
import { Node } from 'react-x11/node';
import type { Context2D } from 'react-x11/node';
import type { Style } from 'react-x11/style';

/**
 * The element name. The registration key, the node's `kind` and the JSX tag
 * are all this one string — react-x11 rejects a node whose `kind` is
 * anything but the name it was registered under, because `kind` is what
 * paint order, queries and the DEV style assertion match on.
 */
export const ELEMENT = 'sparkline';

const DEFAULT_COLOR = '#000000';

/**
 * The ntk connection a node is built against. Derived from `Node`'s own
 * constructor rather than imported: react-x11 keeps `NtkApp` in
 * `src/types/nodes.d.ts`, which is not on its exports map, so naming it
 * directly would mean reaching past the public API to describe the public
 * API.
 */
export type NtkApp = ConstructorParameters<typeof Node>[2];

/**
 * The props `<sparkline>` takes. Lives here, beside the node that reads
 * them, rather than with the component — `./index.ts` imports this module,
 * so the other direction would make the pair circular for no gain.
 */
export interface SparklineProps {
  /** The series. Fewer than two points draws nothing. */
  data: number[];
  /** Stroke colour. Falls back to `style.color`, then black. */
  color?: string;
  /** Pen width in pixels. Default `1`. */
  strokeWidth?: number;
  /** No intrinsic size — give it a width and a height. */
  style?: Style | Style[];
}

/**
 * The slice of ntk's 2d context this element draws through. react-x11 types
 * `Context2D` as `unknown` on purpose — it is ntk's API, not react-x11's —
 * so an element that draws has to say which operations it needs.
 */
interface PathContext {
  lineWidth: number;
  strokeStyle: string;
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

/**
 * The mock backend in `react-x11/test` has no path API. A component that
 * throws there cannot be tested headlessly, and headless is where CI runs —
 * so this is the runtime check that skips the drawing, doubling as the
 * narrowing that lets the rest of `paint` speak to a typed context.
 */
function canDrawPaths(ctx: Context2D): ctx is PathContext {
  return typeof (ctx as Partial<PathContext> | null)?.beginPath === 'function';
}

export class SparklineNode extends Node {
  constructor(props: Record<string, unknown>, app: NtkApp) {
    super(ELEMENT, props, app);
  }

  override paint(ctx: Context2D): void {
    // background, border and the clip to this node's rect
    super.paint(ctx);

    // `Node.props` is `Record<string, unknown>` — react-x11 cannot know
    // what an element it did not write takes — so the narrowing happens
    // once, here. The values still arrive from JSX unchecked, which is why
    // the series is tested below rather than trusted because it has a type.
    const { data, color, strokeWidth } = this
      .props as unknown as Partial<SparklineProps>;

    if (!Array.isArray(data) || data.length < 2) return;
    if (!canDrawPaths(ctx)) return;

    const { x, y, width, height } = this.abs;
    if (width <= 0 || height <= 0) return;

    const lineWidth = strokeWidth ?? 1;
    // `super.paint` clipped to `abs`, so a stroke sitting on the top or
    // bottom edge would be cut in half. Inset by half the pen.
    const inset = lineWidth / 2;
    const top = y + inset;
    const usable = Math.max(0, height - lineWidth);

    let min = Infinity;
    let max = -Infinity;
    for (const value of data) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const span = max - min;

    const stepX = width / (data.length - 1);

    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const px = x + stepX * i;
      // A flat series has no span to scale against; draw it down the middle
      // rather than dividing by zero or pinning it to an edge.
      const py =
        span === 0
          ? y + height / 2
          : top + usable * (1 - (data[i] - min) / span);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = color ?? this.style.color ?? DEFAULT_COLOR;
    ctx.stroke();
    ctx.restore();
  }
}
