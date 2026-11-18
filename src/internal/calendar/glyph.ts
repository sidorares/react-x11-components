// A wall calendar's glyph: the page, its two hangers and the ruled week.
//
// A noun, so a local `<canvas>` rather than one of core's affordance icons
// (AGENTS.md, "Affordance glyphs come from core's set; nouns do not").
// `<DatePicker>`'s trigger draws it, and so does the indicator of a date
// input `<Html>` mounts.
import type { ReactElement } from 'react';

import { hx } from '../hx.js';

/** A wall calendar, `size` across, in `color`. */
export function CalendarGlyph({
  color,
  size,
}: {
  color: string;
  size: number;
}): ReactElement {
  return hx('canvas', {
    style: { width: size, height: size, flexShrink: 0 },
    onDraw: (ctx, { width, height }) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 2.5, width - 1, height - 3);
      ctx.beginPath();
      ctx.moveTo(0.5, 6.5);
      ctx.lineTo(width - 0.5, 6.5);
      ctx.moveTo(4.5, 0.5);
      ctx.lineTo(4.5, 3.5);
      ctx.moveTo(width - 4.5, 0.5);
      ctx.lineTo(width - 4.5, 3.5);
      ctx.stroke();
    },
  });
}
