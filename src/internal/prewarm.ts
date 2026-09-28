// A font family, warmed before the first layout sets text in it.
import { useMemo } from 'react';
import { useApp } from 'react-x11';

/** The one method this needs of `app.fonts`, which ntk's FontManager has
 *  from the release that added it, and other font managers may not. */
interface PrewarmingFonts {
  prewarm?: (family: string) => void;
}

/**
 * Start matching `family`'s faces now, off the event loop, so that the first
 * layout setting text in it takes the answer instead of stalling on the
 * system's font matcher — ntk's `FontManager#prewarm`. fontconfig answers in
 * 20–40 ms on a Linux desktop and in 80–150 on XQuartz, and nothing warms a
 * family but sans-serif until a layout asks for it.
 *
 * Called while rendering, as React's own resource hints are: a component
 * renders ahead of the frame that lays it out, and a long document's render
 * is hundreds of milliseconds of head start that an effect would give away.
 * Once per family; nothing where the app's fonts have nothing to look up
 * (fonts in memory, a native text engine) or predate the method.
 */
export function useFontPrewarm(family: string | null | undefined): void {
  const fonts = (useApp() as { fonts?: PrewarmingFonts } | null)?.fonts;
  useMemo(() => {
    if (family) fonts?.prewarm?.(family);
  }, [fonts, family]);
}

/** The font family a style names, read the way core flattens one — the last
 *  entry of an array that names it wins — or `fallback`. */
export function styleFamily(style: unknown, fallback: string): string {
  let family = fallback;
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const e of entry) visit(e);
    } else if (entry && typeof entry === 'object') {
      const named = (entry as { fontFamily?: unknown }).fontFamily;
      if (typeof named === 'string') family = named;
    }
  };
  visit(style);
  return family;
}
