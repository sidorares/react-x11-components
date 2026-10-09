// A page's `<canvas>`, drawn: the pixels its script drew, which the page's
// realm holds and hands the host a changed rectangle of once a task
// (`canvasPut`), shown over the canvas's box by core's `<image>`, fitted as
// the element's `object-fit` says. The pointer goes through it to the
// document beneath, so what the page hears of the pointer and the keys is
// what `<Html>` tells it of the canvas element (`onDomEvent`): the react-x11
// playground's X server takes its input from the canvas it draws on.
import { useEffect, useMemo, useReducer } from 'react';
import type { ReactElement } from 'react';

import type { Element } from '../../src/html/index.js';
import type { DomHost } from './script/host.js';

/** CSS's `object-fit`, which core's style takes as `objectFit`. */
type Fit = 'fill' | 'contain' | 'cover' | 'none' | 'scale-down';
const FITS = new Set<string>([
  'fill',
  'contain',
  'cover',
  'none',
  'scale-down',
]);

export function CanvasView({
  canvas,
  host,
}: {
  canvas: Element;
  host: DomHost;
}): ReactElement | null {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    // once a turn of the event loop, however many tasks drew in it
    let queued = false;
    const off = host.onCanvas((changed) => {
      if (changed !== canvas || queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        redraw();
      }, 0);
    });
    return () => {
      off();
    };
  }, [host, canvas]);
  const pixels = host.canvas(canvas);
  const version = pixels?.version ?? 0;
  // a new source for each change, which is how `<image>` knows its pixels
  // changed: the data is the host's buffer, written in place
  const src = useMemo(
    () =>
      pixels
        ? { width: pixels.width, height: pixels.height, data: pixels.data }
        : null,
    [pixels, version],
  );
  if (!src || !src.width || !src.height) return null;
  const fit = host.styleOf(canvas)?.['object-fit'] ?? 'fill';
  return (
    <image
      src={src}
      style={{
        width: '100%',
        height: '100%',
        objectFit: (FITS.has(fit) ? fit : 'fill') as Fit,
        pointerEvents: 'none',
      }}
    />
  );
}
