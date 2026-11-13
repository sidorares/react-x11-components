// The mouse as a page hears it: Pointer Events 3 over what `<Html>` tells the
// page's realm of a press, a release and a move, and the mouse's own events
// after them (UI Events).
//
// **This function is source text**, as `installDom` is (`dom.ts`): the engine
// hands it to the context through `Function.prototype.toString()`, so it
// closes over nothing, and `installDom` is handed it and calls it with what it
// needs of the DOM.
//
// There is one pointer, a mouse, and what happens to it goes in the order
// Chromium's `PointerEventManager` has it, which is the order WPT holds a
// browser to: the capture changes hands, the pointer's boundary events go to
// what is under it now and the mouse's after them, then the pointer's event
// and the mouse's. A press and a release are told the same way as a move, since
// nothing says the pointer stayed on what it was on: a press whose listener
// takes its target out has the release go to the parent, after a `mouseover`
// there.
//
// What the pointer is over is kept twice, once a kind, since a listener of the
// pointer's kind can change what the mouse's then finds. The host keeps the
// same thing (`pointerChain` in `host.ts`), because only it sees a node go out
// and come back in one op: an element taken out moves "over" to what held it,
// with nothing told, and the `over` the next event tells has no `enter` with
// it, since the pointer never left what is around it.

/** What `installDom` hands this. */
export interface PointerDeps {
  PointerEvent: unknown;
  MouseEvent: unknown;
  dispatch(target: unknown, event: unknown): boolean;
  call(op: string, ...args: unknown[]): unknown;
  wrap(id: number): unknown;
  view: unknown;
  document(): unknown;
  /** How far the page is scrolled now. */
  scrolled(): { scrollX: number; scrollY: number };
  /** What counts how often the tree may have changed. */
  treeEpoch(): number;
  /** Whether anything listens for `pointerrawupdate`. */
  rawHeard(): boolean;
  /** Whether this page is secure, where `pointerrawupdate` is fired. */
  secure(): boolean;
  /** Whether an element is a disabled form control. */
  disabled(el: unknown): boolean;
  /** A press and its release dismiss the popovers they are outside. */
  lightDismiss(type: string, to: unknown, x: number, y: number): void;
  editForPress(to: unknown, x: number, y: number): boolean;
}

/** What `installDom` has of this. */
export interface PointerInternals {
  /** The id of the pointer last pressed: the mouse's, or a finger's. */
  readonly id: number;
  /** A press or a release of a button; whether its default goes on. */
  press(e: unknown, target: unknown, mods: unknown): boolean;
  /** A move; whether its default goes on. */
  move(e: unknown, target: unknown, mods: unknown): boolean;
  /** What is under a pointer that did not move changed. */
  under(e: unknown, target: unknown): void;
  /** The modifiers a key left held, which a move that was not told has. */
  keyed(mods: unknown): void;
  /** A menu took the secondary button's release. */
  menuOpened(): void;
  /** The pointer left the document `target` is in. */
  left(e: unknown, target: unknown, mods: unknown): void;
  /** The target a click goes to where a capture held the release. */
  clicked(target: unknown): unknown;
  /** What a pointer's event of the user's says of the pointer. */
  fields(buttons: number): Record<string, unknown>;
  /** The buttons held now. */
  held(): number;
  /** The drag has the pointer from here (Pointer Events 3, 5.1.2). */
  dragged(target: unknown): void;
  /** A finger's press became a pan, which the page hears no more of
   *  (Pointer Events 3, 5.1.4, "suppressing a pointer event stream"). */
  cancel(e: unknown, target: unknown, mods: unknown): void;
  setCapture(el: unknown): void;
  releaseCapture(el: unknown): void;
  hasCapture(el: unknown): boolean;
  /** A listener came to want the pointer's moves: what it is over now. */
  seed(target: unknown): void;
  /** The element the pointer is over, or null. */
  over(): unknown;
}

export function installPointers(deps: PointerDeps): PointerInternals {
  type Any = any;
  const PointerEvent = deps.PointerEvent as Any;
  const MouseEvent = deps.MouseEvent as Any;
  const { dispatch, call, scrolled, view, lightDismiss } = deps;
  const wrap = deps.wrap as (id: number) => Any;
  const MOUSE_ID = 1;
  /** A finger's, as Chromium numbers its first touch pointer. */
  const TOUCH_ID = 2;
  const POINTER = 0;
  const MOUSE = 1;

  /** The mouse's state (Pointer Events 3): the buttons held, as the DOM's
   *  mask, kept from the presses and releases told rather than from a
   *  move's, which carry none on macOS; its capture, the element asked for
   *  (`pending`) and the one its events go to (`target`); and whether a
   *  cancelled pointerdown keeps the mouse's events back (`quiet`). */
  const state: {
    held: number;
    pending: Any;
    target: Any;
    quiet: boolean;
    /** Where a capture held the release, which the click goes to. */
    clickAt: Any;
    /** Where the pointer was last told to be on the screen. */
    screenX: number | null;
    screenY: number | null;
    /** What the realm last asked the host of `over`, by `treeEpoch`. */
    seen: number;
    /** The modifiers held as of the last key. */
    mods: Any;
    /** Whether the pointer last pressed or moved is a finger: one pointer
     *  is told at a time, and a finger has no mouse's events but a tap's. */
    touch: boolean;
  } = {
    held: 0,
    pending: null,
    target: null,
    quiet: false,
    clickAt: null,
    screenX: null,
    screenY: null,
    seen: -1,
    mods: {},
    touch: false,
  };

  /** What the pointer is over, once a kind: the element, and it and every
   *  element around it in the flat tree, deepest first. `gone` says the
   *  element was taken out and `over` has moved to what held it, which has
   *  been told nothing yet. */
  interface Over {
    over: Any;
    chain: Any[];
    gone: boolean;
  }
  const made = (): Over[] => [
    { over: null, chain: [], gone: false },
    { over: null, chain: [], gone: false },
  ];
  /** What it is over in each document: a frame with no realm of its own is
   *  heard here, and the page has the pointer over the frame's element
   *  while it does. */
  const byDocument = new WeakMap<object, Over[]>();
  let overs = made();
  const inDocumentOf = (el: Any): void => {
    const doc = el.ownerDocument;
    let found = byDocument.get(doc);
    if (!found) byDocument.set(doc, (found = made()));
    if (found !== overs) state.seen = -1;
    overs = found;
  };

  /** The chain the host keeps for a kind, read as it makes it. */
  const chainOf = (kind: number, el: Any): Any[] => {
    const ids = String(call('pointerChain', kind, el ? el._id : 0));
    return ids ? ids.split(',').map((id) => wrap(Number(id))) : [];
  };
  /** Bring `overs` up to what was taken out since they were last read. */
  const follow = (): void => {
    if (!overs[POINTER].over && !overs[MOUSE].over) return;
    const epoch = deps.treeEpoch();
    if (epoch === state.seen) return;
    state.seen = epoch;
    const [pointerAt, mouseAt] = String(call('pointerOver'))
      .split(',')
      .map(Number);
    for (const [kind, at] of [
      [POINTER, pointerAt],
      [MOUSE, mouseAt],
    ]) {
      if (at < 0) continue;
      const s = overs[kind];
      const cut = s.chain.slice(at);
      s.over = cut[0] ?? null;
      s.chain = cut;
      s.gone = true;
    }
  };

  /** A user's event: what `dispatch` is handed. */
  const told = (
    Kind: Any,
    type: string,
    init: Any,
    pageX: number,
    y: number,
  ) => {
    const ev = new Kind(type, init);
    ev.isTrusted = true;
    ev._pageX = pageX;
    ev._pageY = y;
    return ev;
  };
  /** What a pointer's event of the user's says of the pointer. */
  const fields = (buttons: number): Record<string, unknown> => ({
    pointerId: state.touch ? TOUCH_ID : MOUSE_ID,
    pointerType: state.touch ? 'touch' : 'mouse',
    isPrimary: true,
    width: 1,
    height: 1,
    persistentDeviceId: 1,
    // a mouse's is half with a button held and none without (4.1.3)
    pressure: buttons ? 0.5 : 0,
  });

  interface At {
    init: Any;
    pageX: number;
    pageY: number;
  }
  /** What every event of a move or a press carries. A pointer's event has
   *  the point as it was, a fraction of a pixel on a scaled display, and a
   *  mouse's floors it, as Chromium's does (`atMouse`). */
  const pointAt = (e: Any, mods: Any, detail = 0): At => {
    const s = scrolled();
    const pageX = e.x ?? 0;
    const pageY = e.y ?? 0;
    const clientX = pageX - s.scrollX;
    const clientY = pageY - s.scrollY;
    return {
      pageX,
      pageY,
      init: {
        bubbles: true,
        cancelable: true,
        composed: true,
        view,
        detail,
        clientX,
        clientY,
        screenX: e.screenX ?? clientX,
        screenY: e.screenY ?? clientY,
        button: e.button ?? 0,
        // a move's own buttons are none on macOS: the presses told are
        buttons: (e.buttons ?? 0) | state.held,
        ...mods,
      },
    };
  };
  const atMouse = (Kind: Any, type: string, at: At, more: Any = undefined) => {
    const i = at.init;
    return told(
      Kind,
      type,
      {
        ...i,
        ...more,
        clientX: Math.floor(i.clientX),
        clientY: Math.floor(i.clientY),
        screenX: Math.floor(i.screenX),
        screenY: Math.floor(i.screenY),
      },
      Math.floor(at.pageX),
      Math.floor(at.pageY),
    );
  };
  const atPointer = (type: string, at: At, more: Any) =>
    told(
      PointerEvent,
      type,
      { ...at.init, ...fields(at.init.buttons), detail: 0, ...more },
      at.pageX,
      at.pageY,
    );

  /** The boundary events of a kind's move from what it was over to `now`
   *  (UI Events 4.3.3; Chromium's `BoundaryEventDispatcher`): out of the one,
   *  left through every element around it the other is not in, over the
   *  other, entered from the top. What was taken out hears none of it, and
   *  the elements around it that stayed were never left. */
  const setOver = (kind: number, now: Any, at: At): void => {
    follow();
    const s = overs[kind];
    const was = s.over;
    const gone = s.gone;
    if (was === now && !gone) return;
    const before = s.chain;
    s.over = now;
    s.gone = false;
    const after = chainOf(kind, now);
    s.chain = after;
    const left = before.filter((n) => !after.includes(n));
    const entered = after.filter((n) => !before.includes(n)).reverse();
    const prefix = kind === POINTER ? 'pointer' : 'mouse';
    const make = (type: string, more: Any) =>
      kind === POINTER
        ? atPointer(type, at, { button: -1, ...more })
        : atMouse(MouseEvent, type, at, {
            detail: 0,
            button: 0,
            ...more,
          });
    const quiet = { bubbles: false, cancelable: false, composed: false };
    if (was && !gone) {
      dispatch(was, make(`${prefix}out`, { relatedTarget: now }));
    }
    for (const n of left) {
      if (n.isConnected) {
        dispatch(n, make(`${prefix}leave`, { ...quiet, relatedTarget: now }));
      }
    }
    if (now) {
      const from = gone ? null : was;
      dispatch(now, make(`${prefix}over`, { relatedTarget: from }));
      for (const n of entered) {
        dispatch(n, make(`${prefix}enter`, { ...quiet, relatedTarget: from }));
      }
    }
  };
  /** Pointer Events 3, 10.4, "process pending pointer capture": the capture
   *  changes hands, each side told, before the pointer's next event, and the
   *  pointer's boundary events go to what took it before it is told. An
   *  element taken out of the document has lost it, which the document is
   *  told (10.5). */
  const takeCapture = (at: At): boolean => {
    if (state.pending && !state.pending.isConnected) state.pending = null;
    if (state.target === state.pending) return false;
    const was = state.target;
    const captured = { bubbles: true, cancelable: false, button: -1 };
    if (was) {
      dispatch(
        was.isConnected ? was : deps.document(),
        atPointer('lostpointercapture', at, captured),
      );
    }
    // what heard it lost may have taken out what was to have it next
    if (state.pending && !state.pending.isConnected) state.pending = null;
    const next = state.pending;
    call('pointerHover', next ? next._id : 0);
    if (next) {
      setOver(POINTER, next, at);
      state.target = next;
      dispatch(next, atPointer('gotpointercapture', at, captured));
    } else state.target = null;
    return true;
  };

  /** A press's or a release's mask bit, by the DOM's button. */
  const bitOf = (button: number): number => [1, 4, 2, 8, 16][button] ?? 0;

  /** The element the mouse's event goes to: what was hit where it is still
   *  in the document, and else what held it (Chromium's `mouse_target`). */
  const stillHere = (hit: Any): Any => {
    follow();
    const s = overs[POINTER];
    return s.gone && s.over && !hit.isConnected ? s.over : hit;
  };

  const press = (e: Any, target: Any, mods: Any): boolean => {
    inDocumentOf(target);
    state.touch = e.pointerType === 'touch';
    if (state.touch) return touched(e, target, mods);
    const button = e.button ?? 0;
    const bit = bitOf(button);
    const down = e.type === 'mousedown';
    // a press of a button held is a release that was never told, off the
    // document: the earlier press is over
    if (down && state.held & bit) {
      state.held = 0;
      state.pending = null;
      state.quiet = false;
    }
    const wasHeld = state.held;
    state.held = down ? wasHeld | bit : wasHeld & ~bit;
    // the buttons of the release's mask are those left, not those told
    const at = pointAt({ ...e, buttons: 0 }, mods, e.detail ?? 1);
    // a release of a button the document never saw pressed is a mouse's
    // alone
    if (!down && !(wasHeld & bit)) {
      setOver(MOUSE, target, at);
      return deps.disabled(target)
        ? true
        : dispatch(target, atMouse(MouseEvent, e.type, at));
    }
    takeCapture(at);
    const hit = state.target ?? target;
    setOver(POINTER, hit, at);
    setOver(MOUSE, hit, at);
    const to = stillHere(hit);
    // the first button pressed is a pointerdown and the last released a
    // pointerup; a button between is a move (Pointer Events 3, 4.1.3)
    const first = down ? !wasHeld : !state.held;
    const type = first ? (down ? 'pointerdown' : 'pointerup') : 'pointermove';
    if (type === 'pointermove' && deps.rawHeard() && deps.secure()) {
      dispatch(to, atPointer('pointerrawupdate', at, { cancelable: false }));
    }
    const pointerGo = dispatch(to, atPointer(type, at, undefined));
    // a cancelled pointerdown keeps the mouse's events back until the
    // release, and its default with them (11.2), as Chrome has it
    if (type === 'pointerdown') state.quiet = !pointerGo;
    const mouseTo = stillHere(to);
    // a disabled control has pointer events and no mouse's
    const mouseGo =
      state.quiet || deps.disabled(mouseTo)
        ? true
        : dispatch(mouseTo, atMouse(MouseEvent, e.type, at));
    if (type === 'pointerup') {
      // the click goes where the capture held the release
      state.clickAt = state.target;
      // the capture is let go once the buttons are (10.2), and what the
      // pointer is over is asked at once rather than at its next move
      state.quiet = false;
      state.pending = null;
      if (takeCapture(at)) setOver(POINTER, target, at);
    }
    // a press and its release outside the open popovers and dialogs
    // dismiss them (HTML 6.12, 4.11.4)
    if (type === 'pointerdown' || type === 'pointerup') {
      lightDismiss(type, to, at.init.clientX, at.init.clientY);
    }
    // a press in an editing host focuses it and puts the caret there,
    // which leaves nothing for the document's own selection to do
    if (
      type === 'pointerdown' &&
      (e.button ?? 0) === 0 &&
      pointerGo &&
      mouseGo &&
      deps.editForPress(to, at.init.clientX, at.init.clientY)
    ) {
      return false;
    }
    return pointerGo && mouseGo;
  };

  /**
   * A finger's press or release (Pointer Events 3, 11.2, and Chromium's
   * order for a tap): a press is the pointer's alone, and a release its
   * `pointerup`, the pointer gone from what it was over, then the mouse's
   * events a tap is compatible with — over it, a move, a press and a
   * release — before the click. A finger that panned was cancelled
   * (`cancel`) and is released with nothing told.
   */
  const touched = (e: Any, target: Any, mods: Any): boolean => {
    const down = e.type === 'mousedown';
    if (down) {
      state.held = 1;
      const at = pointAt({ ...e, buttons: 0 }, mods, e.detail ?? 1);
      state.quiet = false;
      state.screenX = at.init.screenX;
      state.screenY = at.init.screenY;
      takeCapture(at);
      const hit = state.target ?? target;
      setOver(POINTER, hit, at);
      const to = stillHere(hit);
      // a finger is captured by what it pressed, as though its pointerdown
      // listeners were called just after `setPointerCapture` (Pointer
      // Events 3, 10.6, "implicit pointer capture")
      if (!state.target) state.pending = to;
      const go = dispatch(to, atPointer('pointerdown', at, undefined));
      state.quiet = !go;
      lightDismiss('pointerdown', to, at.init.clientX, at.init.clientY);
      return go;
    }
    if (!state.held) return true;
    state.held = 0;
    const at = pointAt({ ...e, buttons: 0 }, mods, e.detail ?? 1);
    takeCapture(at);
    const hit = stillHere(state.target ?? target);
    const go = dispatch(hit, atPointer('pointerup', at, undefined));
    state.clickAt = state.target;
    state.pending = null;
    takeCapture(at);
    setOver(POINTER, null, at);
    lightDismiss('pointerup', hit, at.init.clientX, at.init.clientY);
    // a cancelled pointerdown keeps the tap's mouse events back
    if (state.quiet || deps.disabled(target)) {
      state.quiet = false;
      return go;
    }
    setOver(MOUSE, target, at);
    dispatch(target, atMouse(MouseEvent, 'mousemove', at, { button: 0 }));
    const pressAt = pointAt(
      { ...e, type: 'mousedown', buttons: 1 },
      mods,
      e.detail ?? 1,
    );
    const pressGo = dispatch(
      stillHere(target),
      atMouse(MouseEvent, 'mousedown', pressAt),
    );
    const releaseGo = dispatch(
      stillHere(target),
      atMouse(MouseEvent, 'mouseup', at),
    );
    return go && pressGo && releaseGo;
  };

  /** How far a move took the pointer, on the screen, since the last. */
  const movement = (x: number, y: number) => {
    const by = {
      movementX: state.screenX === null ? 0 : x - state.screenX,
      movementY: state.screenY === null ? 0 : y - state.screenY,
    };
    state.screenX = x;
    state.screenY = y;
    return by;
  };
  /** A move's samples, as events: one a sample, the last the move itself,
   *  at the same target (Pointer Events 3, 5.1.2.2). Each is made as a page
   *  asks, since nearly no move is asked. */
  const samplesOf = (
    e: Any,
    at: At,
    event: Any,
    type: string,
    by: { movementX: number; movementY: number },
  ) => {
    const list: [number, number, number][] = e.samples?.length
      ? e.samples
      : [[at.pageX, at.pageY, 0]];
    const lastX = list[list.length - 1][0];
    const lastY = list[list.length - 1][1];
    const stamp = event._timeStamp;
    return () => {
      let fromX = lastX - by.movementX;
      let fromY = lastY - by.movementY;
      const scrolledX = at.pageX - at.init.clientX;
      const scrolledY = at.pageY - at.init.clientY;
      const out = list.map(([x, y, behind]) => {
        const sample = told(
          PointerEvent,
          type,
          {
            ...at.init,
            ...fields(at.init.buttons),
            detail: 0,
            button: -1,
            bubbles: false,
            cancelable: false,
            composed: false,
            clientX: x - scrolledX,
            clientY: y - scrolledY,
            screenX: at.init.screenX + (x - at.pageX),
            screenY: at.init.screenY + (y - at.pageY),
            movementX: x - fromX,
            movementY: y - fromY,
          },
          x,
          y,
        );
        fromX = x;
        fromY = y;
        sample._target = event._target;
        sample._timeStamp = stamp - behind;
        return sample;
      });
      return out;
    };
  };

  const move = (e: Any, target: Any, mods: Any): boolean => {
    inDocumentOf(target);
    // a finger lifted is over nothing, and a finger cancelled is told no
    // more of
    const touch = e.pointerType === 'touch';
    if (touch && !state.held) return true;
    state.touch = touch;
    const at = pointAt({ ...e, button: 0 }, mods);
    const by = movement(at.init.screenX, at.init.screenY);
    takeCapture(at);
    // a captured pointer is over the element that took it, for its moves
    // and its boundary events alike (10.1)
    let hit = state.target ?? target;
    setOver(POINTER, hit, at);
    const more = { button: -1, ...by };
    if (deps.rawHeard() && deps.secure()) {
      const raw = atPointer('pointerrawupdate', at, {
        ...more,
        cancelable: false,
      });
      raw._samples = samplesOf(e, at, raw, 'pointerrawupdate', by);
      dispatch(hit, raw);
      // a listener of it may have moved the capture or taken its target
      // out: the move goes to what is under the pointer now
      takeCapture(at);
      hit = stillHere(state.target ?? hit);
      setOver(POINTER, hit, at);
    }
    if (!touch) setOver(MOUSE, hit, at);
    const event = atPointer('pointermove', at, more);
    event._samples = samplesOf(e, at, event, 'pointermove', by);
    const go = dispatch(hit, event);
    if (touch || state.quiet || deps.disabled(hit)) return go;
    return dispatch(
      stillHere(hit),
      atMouse(MouseEvent, 'mousemove', at, { ...by, button: 0 }),
    );
  };

  const under = (e: Any, target: Any): void => {
    if (state.target) return;
    inDocumentOf(target);
    const at = pointAt({ ...e, button: 0 }, state.mods);
    setOver(POINTER, target, at);
    setOver(MOUSE, target, at);
  };
  const left = (e: Any, target: Any, mods: Any): void => {
    inDocumentOf(target);
    const at = pointAt({ ...e, button: 0 }, mods);
    setOver(POINTER, null, at);
    setOver(MOUSE, null, at);
  };

  return {
    get id() {
      return state.touch ? TOUCH_ID : MOUSE_ID;
    },
    press,
    move,
    under,
    left,
    keyed: (mods) => {
      state.mods = mods;
    },
    menuOpened: () => {
      state.held &= ~bitOf(2);
    },
    clicked: (target) => {
      const at = state.clickAt;
      state.clickAt = null;
      return at?.isConnected ? at : target;
    },
    fields,
    held: () => state.held,
    dragged: (target) => {
      const at = pointAt({ button: 0 }, {});
      const to = state.target ?? target;
      dispatch(
        to,
        atPointer('pointercancel', at, { button: -1, cancelable: false }),
      );
      state.held = 0;
      state.pending = null;
      state.quiet = false;
      takeCapture(at);
      setOver(POINTER, null, at);
    },
    cancel: (e, target, mods) => {
      if (!state.held) return;
      inDocumentOf(target);
      const at = pointAt({ ...(e as Any), button: 0, buttons: 0 }, mods);
      takeCapture(at);
      const to = stillHere(state.target ?? target);
      dispatch(
        to,
        atPointer('pointercancel', at, { button: -1, cancelable: false }),
      );
      state.held = 0;
      state.pending = null;
      state.quiet = false;
      takeCapture(at);
      setOver(POINTER, null, at);
    },
    // Pointer Events 3, 10.1: the pointer's events go to this element until
    // it lets go or the buttons are released. A pointer with no button held
    // is not captured, as Chrome has it, and the capture changes hands
    // before the pointer's next event (`takeCapture`).
    setCapture: (el) => {
      state.pending = state.held ? el : state.pending;
    },
    releaseCapture: (el) => {
      if (state.pending === el) state.pending = null;
    },
    hasCapture: (el) => state.pending === el,
    seed: (target) => {
      inDocumentOf(target);
      for (const s of overs) {
        s.over = target;
        s.gone = false;
      }
      overs[POINTER].chain = chainOf(POINTER, target);
      overs[MOUSE].chain = chainOf(MOUSE, target);
    },
    over: () => overs[POINTER].over,
  };
}
