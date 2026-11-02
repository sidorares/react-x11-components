// UI Events' and Pointer Events' interfaces as a page's scripts see them:
// `UIEvent`, `FocusEvent`, `MouseEvent`, `PointerEvent`, `WheelEvent`,
// `KeyboardEvent`, `InputEvent`, `CompositionEvent` and `TextEvent`.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the engine
// hands it to the context through `Function.prototype.toString()`, so it
// closes over nothing, and `installDom` is handed it and calls it with what it
// needs of the DOM.
//
// Every attribute is an accessor on its interface's prototype and every value
// a page reads is a `_` field of the event, which is what lets the dispatch
// set one for an event of the user's and no page, and what a library that
// copies an attribute's descriptor off a prototype finds. What an interface
// takes from its dictionary goes through Web IDL's conversions here, so a page
// reads what a browser would: `button` wraps as a `short`, a `view` that is no
// window is a `TypeError`, and so on.
//
// What is the user's and what is a page's differ in a few fields, and the
// constructor is the page's: a `PointerEvent` it makes has no pointer, where
// one of the user's says which it is (`pointers.ts`, which fills them in).

/** What `installDom` hands this. */
export interface UIEventDeps {
  Event: unknown;
  /** Whether a value is a window, for a `view`. */
  isWindow(value: unknown): boolean;
  /** Whether a value is an event target, for a `relatedTarget`. */
  isTarget(value: unknown): boolean;
  /** How far the page is scrolled now. */
  scrolled(): { x: number; y: number };
  /** A viewport point in the coordinates of a target's padding box, through
   *  every transform around it (CSSOM View 7.1), or null where it has none. */
  offsetIn(target: unknown, x: number, y: number): [number, number] | null;
  /** A viewport point in the coordinates of the nearest box around a target
   *  that has a layer of its own, as `layerX` is, or null where it has none. */
  layerIn(target: unknown, x: number, y: number): [number, number] | null;
}

/** What `installDom` has of this. */
export interface UIEventInternals {
  UIEvent: unknown;
  FocusEvent: unknown;
  MouseEvent: unknown;
  PointerEvent: unknown;
  WheelEvent: unknown;
  KeyboardEvent: unknown;
  InputEvent: unknown;
  CompositionEvent: unknown;
  TextEvent: unknown;
  /** Give the interfaces their attributes' shape: `idlAttributes` is made
   *  after they are. */
  shape(idlAttributes: (Interface: unknown) => void): void;
  /** A `TextEvent`, which only the user agent makes: `init`'s `data` its. */
  textEvent(type: string, init?: unknown): unknown;
  /** `getCoalescedEvents` is `[SecureContext]`: there, or not. */
  secure(secure: boolean): void;
}

export function installUIEvents(deps: UIEventDeps): UIEventInternals {
  type Any = any;
  const Event = deps.Event as Any;
  const { isWindow, isTarget, scrolled, offsetIn, layerIn } = deps;

  const EMPTY: Any = Object.freeze({ __proto__: null });

  /** A constructor needs its type (Web IDL 3.7.1). */
  const need = (given: number, name: string): void => {
    if (given === 0) {
      throw new TypeError(
        `Failed to construct '${name}': 1 argument required, but only 0 present.`,
      );
    }
  };
  /** The dictionary a constructor is handed: nothing is an empty one, and
   *  only an object is one (Web IDL 3.2.20). */
  const dict = (init: Any, name: string): Any => {
    if (init === undefined || init === null) return EMPTY;
    if (typeof init !== 'object' && typeof init !== 'function') {
      throw new TypeError(
        `Failed to construct '${name}': The provided value is not of type '${name}Init'.`,
      );
    }
    return init;
  };
  /** Web IDL's conversions, a default where the member is missing. */
  const long = (v: Any): number => Number(v) | 0;
  const short = (v: Any): number => (Number(v) << 16) >> 16;
  const ushort = (v: Any): number => Number(v) & 0xffff;
  const ulong = (v: Any): number => Number(v) >>> 0;
  const double = (v: Any, name: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      throw new TypeError(
        `Failed to construct '${name}': The provided double value is non-finite.`,
      );
    }
    return n;
  };
  const viewOf = (v: Any, name: string): Any => {
    if (v === undefined || v === null) return null;
    if (!isWindow(v)) {
      throw new TypeError(
        `Failed to read the 'view' property from '${name}Init': Failed to convert value to 'Window'.`,
      );
    }
    return v;
  };
  const relatedOf = (v: Any, name: string): Any => {
    if (v === undefined || v === null) return null;
    if (!isTarget(v)) {
      throw new TypeError(
        `Failed to read the 'relatedTarget' property from '${name}Init': Failed to convert value to 'EventTarget'.`,
      );
    }
    return v;
  };

  /** An interface's constants, on it and on its prototype (Web IDL 3.7.3):
   *  a `static readonly` is writable. */
  const constants = (Interface: Any, values: Record<string, number>): void => {
    for (const name of Object.keys(values)) {
      for (const on of [Interface, Interface.prototype]) {
        Object.defineProperty(on, name, {
          value: values[name],
          enumerable: true,
          writable: false,
          configurable: false,
        });
      }
    }
  };
  /** An interface's operations are enumerable and refuse what is no
   *  instance of it (Web IDL 3.7.7), and a class's methods do neither. */
  const apply = Reflect.apply;
  const operations = (Interface: Any, names: string[]): void => {
    const proto = Interface.prototype;
    for (const name of names) {
      const own = proto[name];
      const checked = function (this: Any, ...args: Any[]): Any {
        if (!(this instanceof Interface)) {
          throw new TypeError('Illegal invocation');
        }
        return apply(own, this, args);
      };
      Object.defineProperty(checked, 'name', { value: name });
      Object.defineProperty(checked, 'length', { value: own.length });
      Object.defineProperty(proto, name, {
        value: checked,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  };
  /** What a legacy initializer does: nothing to an event on its way. */
  const dispatching = (event: Any): boolean => event._phase !== 0;

  class UIEvent extends Event {
    _view: Any;
    _detail: number;
    constructor(type: string, init: Any = {}) {
      need(arguments.length, 'UIEvent');
      const d = dict(init, 'UIEvent');
      super(type, d);
      this._view = viewOf(d.view, 'UIEvent');
      this._detail = long(d.detail ?? 0);
    }
    get view(): Any {
      return this._view;
    }
    get detail(): number {
      return this._detail;
    }
    /** UI Events' legacy attribute: what a key or a button was numbered. */
    get which(): number {
      return 0;
    }
    /** The legacy initializer a `createEvent('UIEvents')` is set with. */
    initUIEvent(
      type: string,
      bubbles = false,
      cancelable = false,
      view: Any = null,
      detail = 0,
    ): void {
      if (arguments.length === 0) {
        throw new TypeError(
          "Failed to execute 'initUIEvent' on 'UIEvent': 1 argument required, but only 0 present.",
        );
      }
      if (dispatching(this)) return;
      this.initEvent(type, bubbles, cancelable);
      this._view = viewOf(view, 'UIEvent');
      this._detail = long(detail);
    }
  }

  class FocusEvent extends UIEvent {
    _related: Any;
    constructor(type: string, init: Any = {}) {
      need(arguments.length, 'FocusEvent');
      const d = dict(init, 'FocusEvent');
      super(type, d);
      this._related = relatedOf(d.relatedTarget, 'FocusEvent');
    }
    get relatedTarget(): Any {
      return this._related;
    }
  }

  // `EventModifierInit`'s modifiers past the four with attributes of their
  // own, a bit each (UI Events 7.2)
  const MODIFIERS = [
    'AltGraph',
    'CapsLock',
    'Fn',
    'FnLock',
    'Hyper',
    'NumLock',
    'ScrollLock',
    'Super',
    'Symbol',
    'SymbolLock',
  ];
  const MODIFIER_INITS = MODIFIERS.map((name) => `modifier${name}`);
  const modifierBits = (d: Any): number => {
    if (d === EMPTY) return 0;
    let bits = 0;
    for (let i = 0; i < MODIFIER_INITS.length; i++) {
      if (d[MODIFIER_INITS[i]]) bits |= 1 << i;
    }
    return bits;
  };
  const modifierHeld = (event: Any, key: Any): boolean => {
    switch (String(key)) {
      case 'Shift':
        return event._shiftKey;
      case 'Control':
        return event._ctrlKey;
      case 'Alt':
        return event._altKey;
      case 'Meta':
        return event._metaKey;
      default: {
        const at = MODIFIERS.indexOf(String(key));
        return at >= 0 && (event._modifiers & (1 << at)) !== 0;
      }
    }
  };

  class MouseEvent extends UIEvent {
    _screenX: number;
    _screenY: number;
    _clientX: number;
    _clientY: number;
    _button: number;
    _buttons: number;
    _ctrlKey: boolean;
    _shiftKey: boolean;
    _altKey: boolean;
    _metaKey: boolean;
    _modifiers: number;
    _related: Any;
    /** `movementX` and `movementY`, which only a move has. */
    _movementX: number;
    _movementY: number;
    /** Where it was in the page and in its target, as they were when it was
     *  told, for one of the user's: a read after it reads the same. */
    _pageX: number | null = null;
    _pageY: number | null = null;
    _offset: [number, number] | null = null;
    _layer: [number, number] | null = null;
    constructor(type: string, init: Any = {}) {
      need(arguments.length, 'MouseEvent');
      const d = dict(init, 'MouseEvent');
      super(type, d);
      this._screenX = double(d.screenX ?? 0, 'MouseEvent');
      this._screenY = double(d.screenY ?? 0, 'MouseEvent');
      this._clientX = double(d.clientX ?? 0, 'MouseEvent');
      this._clientY = double(d.clientY ?? 0, 'MouseEvent');
      this._button = short(d.button ?? 0);
      this._buttons = ushort(d.buttons ?? 0);
      this._ctrlKey = !!d.ctrlKey;
      this._shiftKey = !!d.shiftKey;
      this._altKey = !!d.altKey;
      this._metaKey = !!d.metaKey;
      this._modifiers = modifierBits(d);
      this._related = relatedOf(d.relatedTarget, 'MouseEvent');
      this._movementX = double(d.movementX ?? 0, 'MouseEvent');
      this._movementY = double(d.movementY ?? 0, 'MouseEvent');
    }
    get screenX(): number {
      return this._screenX;
    }
    get screenY(): number {
      return this._screenY;
    }
    get clientX(): number {
      return this._clientX;
    }
    get clientY(): number {
      return this._clientY;
    }
    get x(): number {
      return this._clientX;
    }
    get y(): number {
      return this._clientY;
    }
    get ctrlKey(): boolean {
      return this._ctrlKey;
    }
    get shiftKey(): boolean {
      return this._shiftKey;
    }
    get altKey(): boolean {
      return this._altKey;
    }
    get metaKey(): boolean {
      return this._metaKey;
    }
    get button(): number {
      return this._button;
    }
    get buttons(): number {
      return this._buttons;
    }
    get relatedTarget(): Any {
      return this._related;
    }
    get movementX(): number {
      return this._movementX;
    }
    get movementY(): number {
      return this._movementY;
    }
    // CSSOM View 7.1: a page's event with no view is at its own coordinates
    get pageX(): number {
      if (this._pageX !== null) return this._pageX;
      return this._view ? this._clientX + scrolled().x : this._clientX;
    }
    get pageY(): number {
      if (this._pageY !== null) return this._pageY;
      return this._view ? this._clientY + scrolled().y : this._clientY;
    }
    /** Where it is in its target's padding box, worked out once it is
     *  asked: nearly no event is. */
    _relative(): [number, number] | null {
      if (this._offset) return this._offset;
      const target = this._target;
      const found = target ? offsetIn(target, this._clientX, this._clientY) : 0;
      if (found) this._offset = found;
      return found || null;
    }
    get offsetX(): number {
      return this._relative()?.[0] ?? this._clientX;
    }
    get offsetY(): number {
      return this._relative()?.[1] ?? this._clientY;
    }
    _inLayer(): [number, number] | null {
      if (this._layer) return this._layer;
      const target = this._target;
      const found = target ? layerIn(target, this._clientX, this._clientY) : 0;
      if (found) this._layer = found;
      return found || null;
    }
    get layerX(): number {
      return this._inLayer()?.[0] ?? this.pageX;
    }
    get layerY(): number {
      return this._inLayer()?.[1] ?? this.pageY;
    }
    // what a legacy page reads: the element it came from and goes to
    get fromElement(): Any {
      const type = this._type;
      if (type === 'mouseover' || type === 'mouseenter') return this._related;
      return type === 'mouseout' || type === 'mouseleave' ? this._target : null;
    }
    get toElement(): Any {
      const type = this._type;
      if (type === 'mouseout' || type === 'mouseleave') return this._related;
      return type === 'mouseover' || type === 'mouseenter'
        ? this._target
        : null;
    }
    override get which(): number {
      return this._button < 0 ? 0 : this._button + 1;
    }
    getModifierState(key: string): boolean {
      if (arguments.length === 0) {
        throw new TypeError(
          "Failed to execute 'getModifierState' on 'MouseEvent': 1 argument required, but only 0 present.",
        );
      }
      return modifierHeld(this, key);
    }
    /** The legacy initializer a `createEvent('MouseEvents')` is set with. */
    initMouseEvent(
      type: string,
      bubbles = false,
      cancelable = false,
      view: Any = null,
      detail = 0,
      screenX = 0,
      screenY = 0,
      clientX = 0,
      clientY = 0,
      ctrlKey = false,
      altKey = false,
      shiftKey = false,
      metaKey = false,
      button = 0,
      relatedTarget: Any = null,
    ): void {
      if (arguments.length === 0) {
        throw new TypeError(
          "Failed to execute 'initMouseEvent' on 'MouseEvent': 1 argument required, but only 0 present.",
        );
      }
      if (dispatching(this)) return;
      this.initUIEvent(type, bubbles, cancelable, view, detail);
      this._screenX = long(screenX);
      this._screenY = long(screenY);
      this._clientX = long(clientX);
      this._clientY = long(clientY);
      this._ctrlKey = !!ctrlKey;
      this._altKey = !!altKey;
      this._shiftKey = !!shiftKey;
      this._metaKey = !!metaKey;
      this._button = short(button);
      this._related = relatedOf(relatedTarget, 'MouseEvent');
    }
  }

  const DEGREES = 180 / Math.PI;
  /** A pointer's tilt as the angles it is also read as (Pointer Events 3,
   *  5.1.1.3, "converting between tiltX/tiltY and altitudeAngle/
   *  azimuthAngle"). */
  const anglesOfTilt = (tiltX: number, tiltY: number): [number, number] => {
    const x = tiltX / DEGREES;
    const y = tiltY / DEGREES;
    let azimuth = 0;
    if (tiltX === 0) {
      if (tiltY > 0) azimuth = Math.PI / 2;
      else if (tiltY < 0) azimuth = (3 * Math.PI) / 2;
    } else if (tiltY === 0) {
      if (tiltX < 0) azimuth = Math.PI;
    } else if (Math.abs(tiltX) === 90 || Math.abs(tiltY) === 90) {
      azimuth = 0;
    } else {
      azimuth = Math.atan2(Math.tan(y), Math.tan(x));
      if (azimuth < 0) azimuth += 2 * Math.PI;
    }
    let altitude: number;
    if (Math.abs(tiltX) === 90 || Math.abs(tiltY) === 90) altitude = 0;
    else if (tiltX === 0) altitude = Math.PI / 2 - Math.abs(y);
    else if (tiltY === 0) altitude = Math.PI / 2 - Math.abs(x);
    else altitude = Math.atan(1 / Math.hypot(Math.tan(x), Math.tan(y)));
    return [altitude, azimuth];
  };
  const tiltOfAngles = (
    altitude: number,
    azimuth: number,
  ): [number, number] => {
    let x = 0;
    let y = 0;
    if (altitude === 0) {
      const half = Math.PI / 2;
      const turn = 2 * Math.PI;
      if (azimuth === 0 || azimuth === turn) x = half;
      else if (azimuth === half) y = half;
      else if (azimuth === Math.PI) x = -half;
      else if (azimuth === 3 * half) y = -half;
      else if (azimuth > 0 && azimuth < half) [x, y] = [half, half];
      else if (azimuth > half && azimuth < Math.PI) [x, y] = [-half, half];
      else if (azimuth > Math.PI && azimuth < 3 * half) [x, y] = [-half, -half];
      else if (azimuth > 3 * half && azimuth < turn) [x, y] = [half, -half];
    } else {
      const tan = Math.tan(altitude);
      x = Math.atan(Math.cos(azimuth) / tan);
      y = Math.atan(Math.sin(azimuth) / tan);
    }
    // a `long` has no negative zero
    return [Math.round(x * DEGREES) || 0, Math.round(y * DEGREES) || 0];
  };

  /** A sequence of events a dictionary hands in (`coalescedEvents`). */
  const eventsOf = (v: Any): Any[] => {
    if (v === undefined || v === null) return [];
    const out = Array.from(v as Iterable<Any>);
    for (const event of out) {
      if (!(event instanceof PointerEvent)) {
        throw new TypeError(
          "Failed to construct 'PointerEvent': The provided value is not of type 'PointerEvent'.",
        );
      }
    }
    return out;
  };

  class PointerEvent extends MouseEvent {
    _pointerId: number;
    _width: number;
    _height: number;
    _pressure: number;
    _tangentialPressure: number;
    _tiltX: number;
    _tiltY: number;
    _twist: number;
    _altitudeAngle: number;
    _azimuthAngle: number;
    _pointerType: string;
    _isPrimary: boolean;
    _persistentDeviceId: number;
    _coalesced: Any[];
    _predicted: Any[];
    /** The samples a move of the user's gathered, made into events when a
     *  page asks (`pointers.ts`): most moves are not asked. */
    _samples: (() => Any[]) | null = null;
    constructor(type: string, init: Any = {}) {
      need(arguments.length, 'PointerEvent');
      const d = dict(init, 'PointerEvent');
      super(type, d);
      const bad = 'PointerEvent';
      this._pointerId = long(d.pointerId ?? 0);
      this._width = double(d.width ?? 1, bad);
      this._height = double(d.height ?? 1, bad);
      this._pressure = Math.fround(double(d.pressure ?? 0, bad));
      this._tangentialPressure = Math.fround(
        double(d.tangentialPressure ?? 0, bad),
      );
      this._twist = long(d.twist ?? 0);
      const hasTilt = d.tiltX !== undefined || d.tiltY !== undefined;
      const hasAngles =
        d.altitudeAngle !== undefined || d.azimuthAngle !== undefined;
      this._tiltX = long(d.tiltX ?? 0);
      this._tiltY = long(d.tiltY ?? 0);
      this._altitudeAngle = double(d.altitudeAngle ?? Math.PI / 2, bad);
      this._azimuthAngle = double(d.azimuthAngle ?? 0, bad);
      if (hasTilt && !hasAngles) {
        [this._altitudeAngle, this._azimuthAngle] = anglesOfTilt(
          this._tiltX,
          this._tiltY,
        );
      } else if (hasAngles && !hasTilt) {
        [this._tiltX, this._tiltY] = tiltOfAngles(
          this._altitudeAngle,
          this._azimuthAngle,
        );
      }
      this._pointerType = String(d.pointerType ?? '');
      this._isPrimary = !!d.isPrimary;
      this._persistentDeviceId = long(d.persistentDeviceId ?? 0);
      this._coalesced = eventsOf(d.coalescedEvents);
      this._predicted = eventsOf(d.predictedEvents);
    }
    get pointerId(): number {
      return this._pointerId;
    }
    get width(): number {
      return this._width;
    }
    get height(): number {
      return this._height;
    }
    get pressure(): number {
      return this._pressure;
    }
    get tangentialPressure(): number {
      return this._tangentialPressure;
    }
    get tiltX(): number {
      return this._tiltX;
    }
    get tiltY(): number {
      return this._tiltY;
    }
    get twist(): number {
      return this._twist;
    }
    get altitudeAngle(): number {
      return this._altitudeAngle;
    }
    get azimuthAngle(): number {
      return this._azimuthAngle;
    }
    get pointerType(): string {
      return this._pointerType;
    }
    get isPrimary(): boolean {
      return this._isPrimary;
    }
    get persistentDeviceId(): number {
      return this._persistentDeviceId;
    }
    // a pointer's own event answers for what `click` names, and no mouse
    // event's legacy pair says anything of it (Pointer Events 3, 5.1.2)
    override get fromElement(): Any {
      return null;
    }
    override get toElement(): Any {
      return null;
    }
    getPredictedEvents(): Any[] {
      return this._predicted.slice();
    }
  }
  /** `[SecureContext]`, so a method of a secure page's alone (`secure`). */
  const getCoalescedEvents = function (this: Any): Any[] {
    if (!(this instanceof PointerEvent)) {
      throw new TypeError('Illegal invocation');
    }
    const event = this as Any;
    if (event._samples) {
      event._coalesced = event._samples();
      event._samples = null;
    }
    return event._coalesced.slice();
  };

  class WheelEvent extends MouseEvent {
    _deltaX: number;
    _deltaY: number;
    _deltaZ: number;
    _deltaMode: number;
    constructor(type: string, init: Any = {}) {
      need(arguments.length, 'WheelEvent');
      const d = dict(init, 'WheelEvent');
      super(type, d);
      this._deltaX = double(d.deltaX ?? 0, 'WheelEvent');
      this._deltaY = double(d.deltaY ?? 0, 'WheelEvent');
      this._deltaZ = double(d.deltaZ ?? 0, 'WheelEvent');
      this._deltaMode = ulong(d.deltaMode ?? 0);
    }
    get deltaX(): number {
      return this._deltaX;
    }
    get deltaY(): number {
      return this._deltaY;
    }
    get deltaZ(): number {
      return this._deltaZ;
    }
    get deltaMode(): number {
      return this._deltaMode;
    }
  }

  class KeyboardEvent extends UIEvent {
    _key: string;
    _code: string;
    _location: number;
    _repeat: boolean;
    _isComposing: boolean;
    _ctrlKey: boolean;
    _shiftKey: boolean;
    _altKey: boolean;
    _metaKey: boolean;
    _modifiers: number;
    _keyCode: number;
    _charCode: number;
    constructor(type: string, init: Any = {}) {
      need(arguments.length, 'KeyboardEvent');
      const d = dict(init, 'KeyboardEvent');
      super(type, d);
      this._key = String(d.key ?? '');
      this._code = String(d.code ?? '');
      this._location = ulong(d.location ?? 0);
      this._repeat = !!d.repeat;
      this._isComposing = !!d.isComposing;
      this._ctrlKey = !!d.ctrlKey;
      this._shiftKey = !!d.shiftKey;
      this._altKey = !!d.altKey;
      this._metaKey = !!d.metaKey;
      this._modifiers = modifierBits(d);
      this._keyCode = ulong(d.keyCode ?? 0);
      this._charCode = ulong(d.charCode ?? 0);
    }
    get key(): string {
      return this._key;
    }
    get code(): string {
      return this._code;
    }
    get location(): number {
      return this._location;
    }
    get ctrlKey(): boolean {
      return this._ctrlKey;
    }
    get shiftKey(): boolean {
      return this._shiftKey;
    }
    get altKey(): boolean {
      return this._altKey;
    }
    get metaKey(): boolean {
      return this._metaKey;
    }
    get repeat(): boolean {
      return this._repeat;
    }
    get isComposing(): boolean {
      return this._isComposing;
    }
    get keyCode(): number {
      return this._keyCode;
    }
    get charCode(): number {
      return this._charCode;
    }
    override get which(): number {
      return this._keyCode || this._charCode;
    }
    getModifierState(key: string): boolean {
      if (arguments.length === 0) {
        throw new TypeError(
          "Failed to execute 'getModifierState' on 'KeyboardEvent': 1 argument required, but only 0 present.",
        );
      }
      return modifierHeld(this, key);
    }
    /** The legacy initializer a `createEvent('KeyboardEvent')` is set with. */
    initKeyboardEvent(
      type: string,
      bubbles = false,
      cancelable = false,
      view: Any = null,
      key = '',
      location = 0,
      ctrlKey = false,
      altKey = false,
      shiftKey = false,
      metaKey = false,
    ): void {
      if (arguments.length === 0) {
        throw new TypeError(
          "Failed to execute 'initKeyboardEvent' on 'KeyboardEvent': 1 argument required, but only 0 present.",
        );
      }
      if (dispatching(this)) return;
      this.initUIEvent(type, bubbles, cancelable, view);
      this._key = String(key);
      this._location = ulong(location);
      this._ctrlKey = !!ctrlKey;
      this._altKey = !!altKey;
      this._shiftKey = !!shiftKey;
      this._metaKey = !!metaKey;
    }
  }

  class InputEvent extends UIEvent {
    _data: string | null;
    _inputType: string;
    _isComposing: boolean;
    _dataTransfer: Any;
    _ranges: Any[] | null = null;
    constructor(type: string, init: Any = {}) {
      need(arguments.length, 'InputEvent');
      const d = dict(init, 'InputEvent');
      super(type, d);
      this._data =
        d.data === undefined || d.data === null ? null : String(d.data);
      this._inputType = String(d.inputType ?? '');
      this._isComposing = !!d.isComposing;
      this._dataTransfer = d.dataTransfer ?? null;
    }
    get data(): string | null {
      return this._data;
    }
    get inputType(): string {
      return this._inputType;
    }
    get isComposing(): boolean {
      return this._isComposing;
    }
    get dataTransfer(): Any {
      return this._dataTransfer;
    }
    /** What an edit will change, while its `beforeinput` is on its way
     *  (Input Events 2, 4.1): `_ranges` is what the edit found, and a page
     *  that keeps the event reads nothing of it after. */
    getTargetRanges(): Any[] {
      return this._phase === 0 ? [] : (this._ranges ?? []).slice();
    }
  }

  class CompositionEvent extends UIEvent {
    _data: string;
    constructor(type: string, init: Any = {}) {
      need(arguments.length, 'CompositionEvent');
      const d = dict(init, 'CompositionEvent');
      super(type, d);
      this._data = String(d.data ?? '');
    }
    get data(): string {
      return this._data;
    }
    /** The legacy initializer a `createEvent('CompositionEvent')` is set
     *  with. */
    initCompositionEvent(
      type: string,
      bubbles = false,
      cancelable = false,
      view: Any = null,
      data = '',
    ): void {
      if (arguments.length === 0) {
        throw new TypeError(
          "Failed to execute 'initCompositionEvent' on 'CompositionEvent': 1 argument required, but only 0 present.",
        );
      }
      if (dispatching(this)) return;
      this.initUIEvent(type, bubbles, cancelable, view);
      this._data = String(data);
    }
  }

  /** What only this module makes a `TextEvent` with: it has no constructor a
   *  page can call (UI Events, Legacy Event Initializers), but `createEvent`. */
  const TEXT_EVENT = Symbol('TextEvent');
  class TextEvent extends UIEvent {
    _data = '';
    constructor(...made: Any[]) {
      if (made[0] !== TEXT_EVENT) throw new TypeError('Illegal constructor');
      super(made[1], made[2]);
    }
    get data(): string {
      return this._data;
    }
    initTextEvent(
      type: string,
      bubbles = false,
      cancelable = false,
      view: Any = null,
      data = 'undefined',
    ): void {
      if (arguments.length === 0) {
        throw new TypeError(
          "Failed to execute 'initTextEvent' on 'TextEvent': 1 argument required, but only 0 present.",
        );
      }
      if (dispatching(this)) return;
      this.initUIEvent(type, bubbles, cancelable, view);
      this._data = String(data);
    }
  }

  constants(WheelEvent, {
    DOM_DELTA_PIXEL: 0,
    DOM_DELTA_LINE: 1,
    DOM_DELTA_PAGE: 2,
  });
  constants(KeyboardEvent, {
    DOM_KEY_LOCATION_STANDARD: 0,
    DOM_KEY_LOCATION_LEFT: 1,
    DOM_KEY_LOCATION_RIGHT: 2,
    DOM_KEY_LOCATION_NUMPAD: 3,
  });
  operations(UIEvent, ['initUIEvent']);
  operations(MouseEvent, ['getModifierState', 'initMouseEvent']);
  operations(PointerEvent, ['getPredictedEvents']);
  operations(KeyboardEvent, ['getModifierState', 'initKeyboardEvent']);
  operations(InputEvent, ['getTargetRanges']);
  operations(CompositionEvent, ['initCompositionEvent']);
  operations(TextEvent, ['initTextEvent']);

  const INTERFACES = [
    UIEvent,
    FocusEvent,
    MouseEvent,
    PointerEvent,
    WheelEvent,
    KeyboardEvent,
    InputEvent,
    CompositionEvent,
    TextEvent,
  ];
  return {
    UIEvent,
    FocusEvent,
    MouseEvent,
    PointerEvent,
    WheelEvent,
    KeyboardEvent,
    InputEvent,
    CompositionEvent,
    TextEvent,
    shape: (idlAttributes) => {
      for (const Interface of INTERFACES) idlAttributes(Interface);
    },
    textEvent: (type, init: Any = {}) => {
      const event = new TextEvent(TEXT_EVENT, type, init);
      event._data = String(init.data ?? '');
      return event;
    },
    secure: (secure) => {
      if (secure) {
        Object.defineProperty(PointerEvent.prototype, 'getCoalescedEvents', {
          value: getCoalescedEvents,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else delete (PointerEvent.prototype as Any).getCoalescedEvents;
    },
  };
}
