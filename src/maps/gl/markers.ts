// The markers, as the GL renderer draws them: a quad each, in one instanced
// draw, shaded by its distance to the marker's outline (`MARKER_FRAGMENT`) —
// a disc, or a pin's teardrop, and the ring around it. Which markers, in
// what order, where and in what colours is `../overlay.ts`'s, which the
// retained renderer draws from too; what is here is only the packing.
import {
  MARKER_SIZE,
  PIN_HEIGHT,
  markerPaint,
  markersInView,
} from '../overlay.js';
import type { MapMarker, OverlayPalette } from '../overlay.js';
import type { Transform } from '../proj.js';
import { parseColor, premultiplied } from './color.js';
import type { Rgba } from './color.js';

/**
 * Floats per marker: the point it marks, in device pixels — a pin's tip, a
 * disc's centre — its head's radius, and how far above the point the head's
 * centre is (0 for a disc); the fill; the ring; the ring's width, and one
 * float unused.
 */
export const MARKER_INSTANCE = 14;

/** A frame's markers, bottom first. */
export interface MarkerBatch {
  instances: Float32Array;
  count: number;
}

const CLEAR: Rgba = [0, 0, 0, 0];

export class MarkerBatcher {
  private _instances = new Float32Array(MARKER_INSTANCE * 16);
  private readonly _colors = new Map<string, Rgba>();

  /**
   * The markers in view, bottom first. `transform` is the map's at this
   * frame and `pane` its size, in logical pixels.
   */
  batch(
    markers: readonly MapMarker[],
    transform: Transform,
    pane: { width: number; height: number },
    scale: number,
    palette: OverlayPalette,
  ): MarkerBatch {
    const shown = markersInView(markers, transform, pane);
    if (this._instances.length < shown.length * MARKER_INSTANCE) {
      this._instances = new Float32Array(shown.length * MARKER_INSTANCE * 2);
    }
    const d = this._instances;
    shown.forEach(({ marker, rect }, i) => {
      const at = i * MARKER_INSTANCE;
      const size = marker.size ?? MARKER_SIZE;
      const r = (size / 2) * scale;
      const paint = markerPaint(marker, palette, scale);
      d[at] = rect.tipX * scale;
      d[at + 1] = rect.tipY * scale;
      d[at + 2] = r;
      d[at + 3] =
        (marker.shape ?? 'pin') === 'circle'
          ? 0
          : size * PIN_HEIGHT * scale - r;
      d.set(this._color(paint.fill), at + 4);
      d.set(this._color(paint.ring), at + 8);
      d[at + 12] = paint.ringWidth;
      d[at + 13] = 0;
    });
    return { instances: d, count: shown.length };
  }

  private _color(value: string): Rgba {
    let color = this._colors.get(value);
    if (!color) {
      const parsed = parseColor(value);
      color = parsed ? premultiplied(parsed) : CLEAR;
      if (this._colors.size > 256) this._colors.clear();
      this._colors.set(value, color);
    }
    return color;
  }
}
