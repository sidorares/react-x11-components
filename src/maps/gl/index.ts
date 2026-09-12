// The GL renderer's entry: what `<Map>` loads, by dynamic import, when it
// chooses to draw a map through GL — and only then.
//
// **Registration happens when this module is evaluated**, which is the design
// here as it is in `../index.ts`: the pane element (`./pane.ts`) is
// registered by the module that is loaded when GL is chosen, so an
// application that never draws a map through GL registers nothing and
// bundles none of this. The vt terminal's `src/terminal/vt/index.ts` is the
// same shape, for the same reason.
import { registerElement, registeredElements } from 'react-x11/host';

import { GL_PANE, GlPaneNode } from './pane.js';

if (!registeredElements().includes(GL_PANE)) {
  registerElement(GL_PANE, {
    create: (props, app) => new GlPaneNode(props, app),
    // The `<glarea>` the map is drawn in.
    childrenAllowed: true,
  });
}

export { GlMapPane } from './view.js';
export type { GlMapPaneProps } from './view.js';
