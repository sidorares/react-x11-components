// `React.createElement`, typed against react-x11's host elements.
//
// The library writes `h(...)` rather than JSX — a convention inherited from
// core, and worth keeping so moving code between the two repos stays a
// rename. Shared by every composed widget out here (`<Calendar>`,
// `<DatePicker>`, `<ColorPicker>`, `<ColorField>`), which is why it sits in
// `src/internal/` rather than in one of them. But `React.createElement`'s own overloads are `@types/react`'s, and
// they describe the DOM: a `<box onKeyDown>` handler is checked against
// React's `KeyboardEvent`, not react-x11's, and the whole props object is
// measured against `DOMAttributes`. Everything interesting fails.
//
// So the element name is looked up in react-x11's own element table instead.
// `hx('box', …)` gets `<box>`'s real props — `ev.keysym` on a key handler,
// `onDraw` on a `<canvas>` — and `hx('div', …)` is an error, which is the
// same guarantee the JSX namespace gives `examples/` and `test/types/`.
import React from 'react';
import type { Key, ReactElement, ReactNode } from 'react';
import type { ReactX11Elements, Theme } from 'react-x11';

/** The host elements, by name. */
export type Host = ReactX11Elements;

/**
 * What every element takes on top of its own props.
 *
 * `theme` is honoured by **every** node — `Node.theme` merges `props.theme`
 * over the inherited palette, whatever the kind — but react-x11's element
 * declarations only put it on `<window>`. A widget re-declares the theme it
 * read from context onto its own root so that `$token` values still resolve
 * inside a `<popup>`, which is a separate window and does not inherit the
 * trigger's node tree. So the prop is real; only the declaration is narrow.
 */
interface CommonProps {
  key?: Key;
  /** `Theme` is listed alongside the record because it is an interface, and
   *  an interface has no implicit index signature — so the palette `useTheme`
   *  hands back is not assignable to the record react-x11 declares. */
  theme?: Theme | Record<string, string | number>;
}

export function hx<K extends keyof Host>(
  type: K,
  // `theme` is dropped from the element's own props before the merge:
  // `<window>` and `<popup>` already declare it, narrower, and intersecting
  // the two would demand a value satisfying both.
  props?: (Omit<Host[K], 'theme'> & CommonProps) | null,
  ...children: ReactNode[]
): ReactElement {
  // The cast is the whole point of the wrapper: `createElement`'s string
  // overload insists on DOM props, and the signature above has already
  // checked these against the element that will actually receive them.
  return React.createElement(type as string, props as never, ...children);
}
