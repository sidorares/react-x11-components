// The environment variables an `env()` reads (CSS Environment Variables 1,
// 2): the user agent's, which a document cannot set. A module of its own
// because both `vars.ts`, which substitutes an `env()` in a value, and
// `conditions.ts`, which reads one in a `style()` range, ask it, and the
// first imports the second.

/**
 * What a desktop window answers, as Chrome answers on one: a safe area's
 * inset is nothing on a screen with no notch, and no on-screen keyboard
 * overlays the content (VirtualKeyboard API, 4). The title bar's area and
 * the viewport's segments are defined only where the window has them —
 * a controls overlay, a folding screen — and this one has neither, so an
 * `env()` naming them takes its fallback.
 */
const ENVIRONMENT = new Map<string, string>(
  [
    'safe-area-inset-top',
    'safe-area-inset-right',
    'safe-area-inset-bottom',
    'safe-area-inset-left',
    'safe-area-max-inset-top',
    'safe-area-max-inset-right',
    'safe-area-max-inset-bottom',
    'safe-area-max-inset-left',
    'keyboard-inset-top',
    'keyboard-inset-right',
    'keyboard-inset-bottom',
    'keyboard-inset-left',
    'keyboard-inset-width',
    'keyboard-inset-height',
  ].map((name) => [name, '0px']),
);

/**
 * The value of the environment variable `name`, at `indices` where it is
 * one of an array of them, or undefined where there is none: a name the
 * user agent does not define, or indices given to one that takes none.
 * A name is a `<custom-ident>`, so it is compared as written.
 */
export function environmentValue(
  name: string,
  indices: readonly number[] = [],
): string | undefined {
  return indices.length ? undefined : ENVIRONMENT.get(name);
}
