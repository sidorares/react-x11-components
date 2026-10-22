// The style both surfaces share — the `<foreign>` a player is embedded in
// and the `<video>` ffmpeg's frames are pushed to — so that switching backend
// does not move or recolour the box.
import type { Style } from 'react-x11/style';

/**
 * Black rather than the theme background: this is a video surface, and what
 * shows around a letterboxed frame should be what a player would put there.
 */
export function surfaceStyles(
  theme: Record<string, unknown>,
  extra: Style | Style[] | undefined,
): Style[] {
  const styles: Style[] = [
    {
      flexGrow: 1,
      backgroundColor: String(theme.videoBackground ?? '#000000'),
    },
  ];
  if (extra) {
    for (const style of Array.isArray(extra) ? extra : [extra]) {
      styles.push(style);
    }
  }
  return styles;
}
