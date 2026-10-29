// The tools' drawn glyphs: actions core's icon set has no mark for — a
// copy, a bin — drawn here, as AGENTS.md has it for this package's nouns.
import type { ReactElement } from 'react';
import { useTheme } from 'react-x11';

/** Two sheets, one over the other. */
export function CopyGlyph(): ReactElement {
  const theme = useTheme();
  return (
    <canvas
      style={{ width: 12, height: 12 }}
      onDraw={(ctx, info) => {
        const s = info.width / 12;
        ctx.strokeStyle = theme.textMuted;
        ctx.lineWidth = info.scale;
        ctx.strokeRect(3.5 * s, 0.5 * s, 8 * s, 8.5 * s);
        ctx.fillStyle = theme.background;
        ctx.fillRect(0.5 * s, 3 * s, 8 * s, 8.5 * s);
        ctx.strokeRect(0.5 * s, 3 * s, 8 * s, 8.5 * s);
      }}
    />
  );
}

/** A bin with a lid. */
export function TrashGlyph(): ReactElement {
  const theme = useTheme();
  return (
    <canvas
      style={{ width: 12, height: 12 }}
      onDraw={(ctx, info) => {
        const s = info.width / 12;
        ctx.strokeStyle = theme.textMuted;
        ctx.lineWidth = info.scale;
        ctx.beginPath();
        ctx.moveTo(1 * s, 2.5 * s);
        ctx.lineTo(11 * s, 2.5 * s);
        ctx.moveTo(4.5 * s, 2.5 * s);
        ctx.lineTo(4.5 * s, 0.8 * s);
        ctx.lineTo(7.5 * s, 0.8 * s);
        ctx.lineTo(7.5 * s, 2.5 * s);
        ctx.moveTo(2.5 * s, 2.5 * s);
        ctx.lineTo(3.2 * s, 11.2 * s);
        ctx.lineTo(8.8 * s, 11.2 * s);
        ctx.lineTo(9.5 * s, 2.5 * s);
        ctx.moveTo(5 * s, 5 * s);
        ctx.lineTo(5 * s, 9 * s);
        ctx.moveTo(7 * s, 5 * s);
        ctx.lineTo(7 * s, 9 * s);
        ctx.stroke();
      }}
    />
  );
}

/** A circle struck through: a log cleared. */
export function ClearGlyph(): ReactElement {
  const theme = useTheme();
  return (
    <canvas
      style={{ width: 12, height: 12 }}
      onDraw={(ctx, info) => {
        const w = info.width;
        const c = w / 2;
        const r = c - info.scale;
        ctx.strokeStyle = theme.textMuted;
        ctx.lineWidth = 1.2 * info.scale;
        ctx.beginPath();
        ctx.arc(c, c, r, 0, Math.PI * 2);
        ctx.stroke();
        const d = r * Math.SQRT1_2;
        ctx.beginPath();
        ctx.moveTo(c - d, c + d);
        ctx.lineTo(c + d, c - d);
        ctx.stroke();
      }}
    />
  );
}
