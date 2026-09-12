// The GL renderer's pane: the box its `<glarea>` sits in, as an element of
// its own.
//
// It exists for everything the surface cannot be. A `<glarea>` is a window
// of its own — a child X window on X11, a CALayer on the Cocoa backend — so
// core's hit test skips it and answers with the node behind it, which is
// this one: the pane's handlers are what Cocoa's presses, drags and wheels
// reach, and what X11's wheel bubbles to (core forwards the wheel from the
// child window, named at the surface). It takes the keyboard focus, so the
// arrows and +/− work. It is what an assistive technology meets — the markers
// in view, as buttons, the same scene the retained renderer's element answers
// with. And it paints the style's background under the surface, which is
// what the pane shows before the first GL frame, and on a connection where
// the surface never draws at all.
//
// Registered by `./index.ts` when the GL renderer is loaded, and not before:
// an application that never draws a map through GL registers nothing.
import { Node } from 'react-x11/node';
import type { A11ySceneItem } from 'react-x11/node';

import type { MapController } from '../controller.js';

/** Registration key, `kind` and tag, one string — react-x11 rejects a node
 *  whose `kind` is not the name it was registered under. */
export const GL_PANE = 'mapglpane';

export class GlPaneNode extends Node {
  constructor(props: Record<string, unknown>, app: unknown) {
    super(GL_PANE, props, app as ConstructorParameters<typeof Node>[2]);
    // A map is a thing you drive with the keyboard as well as the mouse,
    // on either renderer.
    this.focusableByDefault = true;
    this.defaultCursor = 'grab';
  }

  /** The markers in view, as buttons — the controller's answer, which the
   *  retained renderer's element gives too. */
  override a11yScene(): A11ySceneItem[] {
    const controller = this.props.mapController as MapController | undefined;
    return controller?.markerScene() ?? [];
  }
}
