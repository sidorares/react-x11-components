// When `<Html>` tells its host that the parse has ended (`onParsed`), and
// the load behind it: once the parse is over and core has laid the element
// out.
//
// A host runs a page's scripts from `onParsed`, and a browser lays a page
// out before a script measures it — Chrome, Firefox and Safari answer a
// `getBoundingClientRect()` in an inline script, at `DOMContentLoaded` and
// at `load` from a layout at the viewport's width. A document mounted with
// its source is parsed in the render that mounts it, and core lays out only
// at the window's next frame, so a script run at the parse found an element
// with no width: the document was laid out at one pixel to answer it, a
// bordered block came to its borders, and `innerWidth` was 0. The frame is
// the window's clock and not a tick of the event loop's: where the display
// paces it, it is a vertical blank away, and the eight `setImmediate`s the
// parse used to wait for it were spent in a millisecond on an X server.
import React from 'react';

import { cancelLater, later } from '../internal/timers.js';
import type { DelayTick } from '../internal/timers.js';

/** How long the parse's end waits for a layout that may never come — an
 *  element in a window that is never drawn, or one React keeps hidden —
 *  before it is told without one. */
const LAYOUT_WAIT_MS = 1000;

/** A node of core's, read through the members every node has. */
interface Placed {
  parent: Placed | null;
  style?: { display?: string } | null;
}

/** Whether a box around the node is `display: none`. Core lays out nothing
 *  inside one and reports no layout, so none is coming: a browser runs a
 *  hidden frame's scripts as it parses it, and so does this. */
function undisplayed(node: Placed | null): boolean {
  for (let at = node; at; at = at.parent) {
    if (at.style?.display === 'none') return true;
  }
  return false;
}

/** What the parse's end and a script it waits at are told to. */
interface Told<S> {
  onParsed?: () => void;
  onLoaded?: () => void;
  _onParserBlocked?: (script: S) => void;
}

/**
 * `onParsed`, held until the element has been laid out, and the `onLayout`
 * that lets it go — core's, which reports a node's first layout from after
 * the pass that made it. `onLoaded` is held behind a parse that is, since
 * the element tells it from whichever layout it finds everything in, which
 * may be one core's measuring made, and a host hears the two in order.
 * Once laid out, a later document's parse is told as it ends, since the
 * element has a width to lay it out at. A script the parse waits at
 * (`onParserBlocked`) is held the same way, and for the same reason: the
 * host runs it from there, and it measures the document as far as it goes.
 */
export function useParsedOnceLaidOut<S>(
  props: Told<S>,
  node: { readonly current: Placed | null },
): {
  onParsed?: () => void;
  onLoaded?: () => void;
  onParserBlocked?: (script: S) => void;
  onLayout?: () => void;
} {
  const latest = React.useRef(props);
  latest.current = props;
  const state = React.useRef({
    laidOut: false,
    /** the script the parse waits at, held for the layout */
    blocked: null as S | null,
    /** the parse's end, held for the layout */
    parsed: false,
    /** the load, held behind it */
    loaded: false,
    /** whether the wait for a layout ran out once: what comes after it is
     *  not held again, so a parse that waits at each of its scripts does
     *  not wait a second for each */
    waited: false,
    timer: null as DelayTick,
  });
  const tell = React.useCallback(() => {
    const s = state.current;
    cancelLater(s.timer);
    s.timer = null;
    if (s.blocked !== null) {
      const script = s.blocked;
      s.blocked = null;
      latest.current._onParserBlocked?.(script);
    }
    if (!s.parsed) return;
    s.parsed = false;
    latest.current.onParsed?.();
    if (!s.loaded) return;
    s.loaded = false;
    latest.current.onLoaded?.();
  }, []);
  const onLayout = React.useCallback(() => {
    state.current.laidOut = true;
    tell();
  }, [tell]);
  const waitedOut = React.useCallback(() => {
    state.current.waited = true;
    tell();
  }, [tell]);
  const hold = React.useCallback(() => {
    const s = state.current;
    if (s.laidOut || s.waited || undisplayed(node.current)) tell();
    else if (!s.timer) s.timer = later(waitedOut, LAYOUT_WAIT_MS);
  }, [tell, waitedOut]);
  const parsed = React.useCallback(() => {
    state.current.parsed = true;
    hold();
  }, [hold]);
  const blocked = React.useCallback(
    (script: S) => {
      state.current.blocked = script;
      hold();
    },
    [hold],
  );
  const loaded = React.useCallback(() => {
    const s = state.current;
    if (s.parsed) s.loaded = true;
    else latest.current.onLoaded?.();
  }, []);
  React.useEffect(() => () => cancelLater(state.current.timer), []);
  return {
    onParsed: props.onParsed ? parsed : undefined,
    onLoaded: props.onLoaded ? loaded : undefined,
    onParserBlocked: props._onParserBlocked ? blocked : undefined,
    // until the first layout: core reports every one that moves the node
    onLayout: state.current.laidOut ? undefined : onLayout,
  };
}
