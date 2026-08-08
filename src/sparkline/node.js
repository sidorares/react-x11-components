// The retained node behind <sparkline>. `./index.js` is the only module
// that imports this one, and it is also the module that registers the
// element — so the pair is reachable exactly when an app imports
// `Sparkline`, and droppable as a unit when it does not (see AGENTS.md,
// "Tree-shaking is a constraint, not a nice-to-have").
import { Node } from 'react-x11/node';

/**
 * The element name. The registration key, the node's `kind` and the JSX tag
 * are all this one string — react-x11 rejects a node whose `kind` is
 * anything but the name it was registered under, because `kind` is what
 * paint order, queries and the DEV style assertion match on.
 */
export const ELEMENT = 'sparkline';

const DEFAULT_COLOR = '#000000';

export class SparklineNode extends Node {
  constructor(props, app) {
    super(ELEMENT, props, app);
  }

  paint(ctx) {
    // background, border and the clip to this node's rect
    super.paint(ctx);

    const data = this.props.data;
    if (!Array.isArray(data) || data.length < 2) return;
    // The mock backend in `react-x11/test` has no path API. A component
    // that throws there cannot be tested headlessly, and headless is where
    // CI runs — so the drawing is skipped rather than attempted.
    if (typeof ctx.beginPath !== 'function') return;

    const { x, y, width, height } = this.abs;
    if (width <= 0 || height <= 0) return;

    const lineWidth = this.props.strokeWidth ?? 1;
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
    ctx.strokeStyle = this.props.color ?? this.style.color ?? DEFAULT_COLOR;
    ctx.stroke();
    ctx.restore();
  }
}
