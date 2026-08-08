// <Sparkline> — a bare line chart, and the worked example of the
// `registerElement` path this whole package is built on. react-x11's own
// docs/extending.md illustrates the seam with a `<sparkline>`; this is that
// element, shipped.
//
// **Registration happens when this module is evaluated**, and that is the
// design, not a shortcut. Nothing in the package registers anything until
// an app imports the component that needs it, so `sideEffects: false` stays
// honest: an app that never renders a sparkline ships none of this. Do not
// move registration up into `../index.ts` — that is the one edit that would
// make the barrel pull every component into every bundle.
import React from 'react';
import type { ReactElement } from 'react';
import { registerElement, registeredElements } from 'react-x11/host';

// Loads the module the JSX augmentation at the bottom of this file targets.
// Nothing in `src/` writes JSX, so without this the build program never
// resolves `react-x11/jsx-runtime` and the augmentation is an error rather
// than an addition. Type-only, so it is erased and costs no bundle.
import type {} from 'react-x11/jsx-runtime';

import { ELEMENT, SparklineNode } from './node.js';
import type { SparklineProps } from './node.js';

export type { SparklineProps };

// Idempotent on purpose. `registerElement` throws on a second registration
// without `override`, which is the right default for two *packages* fighting
// over a name — but an app that ends up with two copies of this one (a
// version skew in someone's lockfile) should not fail to boot over it.
if (!registeredElements().includes(ELEMENT)) {
  registerElement(ELEMENT, {
    create: (props, app) => new SparklineNode(props, app),
    // `color` is also a style name. Without declaring it the element throws
    // on its own props in development and works in production — the worst
    // shape a bug can have, so react-x11 asks elements to say so.
    semanticNames: ['data', 'color', 'strokeWidth'],
    childrenAllowed: false,
  });
}

/**
 * A sparkline. Has no intrinsic size — give it one through `style`, the way
 * react-x11's own `<canvas>` wants one:
 *
 * ```jsx
 * <Sparkline data={[1, 4, 2, 8]} color="#c0392b"
 *            style={{ width: 120, height: 40 }} />
 * ```
 *
 * The component is a thin handle on the host element rather than a wrapper
 * with behaviour of its own: it exists to carry the types, to be the thing
 * an app imports (and therefore the thing that triggers registration), and
 * to be the seam if this ever grows props that are not the element's.
 */
export function Sparkline(props: SparklineProps): ReactElement {
  return React.createElement(ELEMENT, props);
}

/** The host element name, for apps that would rather write `<sparkline>`. */
export { ELEMENT as SPARKLINE_ELEMENT };

// Importing this module teaches JSX the element too, so `<sparkline>` is a
// typed tag and not an error. This is the module-augmentation shape
// react-x11's docs/typescript.md prescribes for a third-party element.
declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      sparkline: SparklineProps;
    }
  }
}
