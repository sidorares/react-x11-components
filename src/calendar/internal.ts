// The bits of react-x11 that `<Calendar>` needs and react-x11 does not export.
//
// Everything else the widget stands on is public — `useTheme`, `createStyles`,
// `useAnchor`/`useAnchorTracking`, the `XK_*` keysyms, the host elements. These
// three are not, so they are vendored, and they are collected here rather than
// scattered so the list stays short and visible. Each is small and pure; if
// core ever puts one on its exports map, delete it from here and import it.

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

// ntk's colour parser is reachable — react-x11 re-exports the toolkit at
// `react-x11/ntk` precisely so an extension does not declare a second,
// independently-versioned `ntk` (two Yoga instances, two font caches). Its
// declarations are deliberately loose and name only the exports an extension
// "actually reaches for"; `cssColorStraight` is one more, and it is there at
// run time.
//
// Read off the namespace rather than declared through `declare module`: an
// augmentation would be emitted into this package's own `.d.ts`, and then a
// program holding both the source and the build — which is exactly what
// `npm run typecheck` does, since `package.test.ts` imports the package by
// name — would see it twice and reject the redeclaration.
import * as ntk from 'react-x11/ntk';

/** `[r, g, b, a]`, each 0-1, unassociated (not premultiplied). */
type StraightColor = [number, number, number, number];

const cssColorStraight = (
  ntk as unknown as {
    cssColorStraight: (color: string) => StraightColor | null;
  }
).cssColorStraight;

function rgba(c: StraightColor): string {
  return `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${c[3]})`;
}

/**
 * A colour at a given opacity — `tint('#2980b9', 0.3)`.
 *
 * For fills that are drawn *under* text whose colour they do not control: the
 * range band is the case here, and an opaque one would have to be chosen to
 * contrast with the ink on top of it, which cannot be done once for both a
 * light and a dark palette. A translucent one is chosen against the surface
 * instead, and the ink keeps whatever contrast it already had.
 *
 * Parsed **straight**, not premultiplied: the result is formatted back into an
 * `rgba()` string and the paint path parses it again, and that round trip only
 * closes on unassociated components.
 */
export function tint(color: string, alpha: number): string {
  const c = cssColorStraight(color);
  if (!c) return color;
  return rgba([c[0], c[1], c[2], c[3] * alpha]);
}

/** The `target` a {@link WidgetChangeEvent} carries. */
export interface ChangeTarget<T> {
  type: string;
  name: string | undefined;
  value: T;
}

/**
 * The change event the value widgets hand their `onChange`.
 *
 * One signature across react-x11's widgets, and this keeps to it so that
 * `onChange={formik.handleChange}` works here too: a form library reads the
 * field out of `ev.target`, and `{ type, name, value }` is exactly the shape
 * formik's `handleChange` and react-hook-form's event reader destructure.
 * `type` is what tells them a date from a text field, which is why it is set
 * even though nothing in react-x11 reads it.
 *
 * `target` is a plain descriptor rather than a node: a widget is a composition
 * of nodes with no single element holding its value, so there is nothing
 * honest to point at. There is no `preventDefault` either — the value has
 * already changed by the time the handler runs.
 */
export interface WidgetChangeEvent<T> {
  type: 'change';
  target: ChangeTarget<T>;
  currentTarget: ChangeTarget<T>;
  name: string | undefined;
  value: T;
}

export function changeEvent<T>(
  type: string,
  name: string | undefined,
  value: T,
): WidgetChangeEvent<T> {
  const target: ChangeTarget<T> = { type, name, value };
  return { type: 'change', target, currentTarget: target, name, value };
}

/** The slice of the owning window a dismiss-on-blur subscription needs.
 *  `DrawnNode` in react-x11's public types does not carry `root`, because a
 *  ref's contract is geometry and focus rather than the window's own events. */
interface NodeWithRoot {
  root?: {
    onWindowFocusChange?: (fn: (focused: boolean) => void) => () => void;
  } | null;
}

/**
 * Close a popup when the *window* loses focus.
 *
 * A trigger keeps its own focus while its override-redirect popup is up, so
 * the trigger's `onBlur` never hears that the application went to the
 * background — and a menu or a calendar left floating over another app's
 * window is the bug that follows.
 */
export function useDismissOnWindowBlur(
  ref: RefObject<unknown>,
  active: boolean,
  onDismiss: () => void,
): void {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!active) return undefined;
    const root = (ref.current as NodeWithRoot | null)?.root;
    if (!root?.onWindowFocusChange) return undefined;
    return root.onWindowFocusChange((focused: boolean) => {
      if (!focused) onDismissRef.current?.();
    });
  }, [active, ref]);
}
