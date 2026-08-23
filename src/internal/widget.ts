// The bits of react-x11 that a value widget needs and react-x11 does not
// export — the change event every one of them emits, and the dismiss-on-blur
// subscription every popup one needs.
//
// It lived in `src/calendar/` while the calendar was the only widget out
// here; `<ColorPicker>` is the second, which is exactly the promotion
// `AGENTS.md` describes for `src/internal/`.
//
// Everything else these widgets stand on is public — `useTheme`,
// `createStyles`, `useAnchor`/`useAnchorTracking`, the `XK_*` keysyms, the
// host elements, and `tint` off `react-x11/style`, which used to be vendored
// here and is not any more. These two are what is left, and they are
// collected here rather than scattered so the list stays short and visible.
// Each is small and pure; if core ever puts one on its exports map, delete it
// from here and import it, the way `tint` was deleted.

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

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
