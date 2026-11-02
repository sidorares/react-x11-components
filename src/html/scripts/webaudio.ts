// Web Audio, as a page's scripts see it: an `AudioContext` and its nodes,
// their parameters and their automation, and a `MediaStreamAudioDestinationNode`
// whose track is a host source (`media-sources.ts`'s synth) that renders
// the oscillators and constant sources reaching it.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing, and `installDom` calls it with what it reaches
// the host by.
//
// **Nothing is heard.** Core has no audio output, so a context's
// `destination` plays nowhere, and every node a context makes keeps the
// state Web Audio gives it — its parameters and their automation, its
// connections, a scheduled source's start, stop and `ended` — while
// processing nothing but what a destination's track renders. That is the
// posture a page that feature-detects `AudioContext` is owed: the whole
// API, never a stub that throws, and silence where a browser with no
// speakers would have silence. `decodeAudioData` reads WAV and rejects
// anything else with the `EncodingError` a browser gives what it cannot
// decode.
//
// What a destination's track renders is worked out here, from the graph:
// each oscillator and constant source that reaches it through gains, at
// the values its parameters have, told to the host whenever the graph or
// a value changes and again at each automation event's time. Anything else
// on a path — a filter, a buffer source, a stream's source — is silence
// there, which is what the host is told it is.

/** What `installDom` hands this. */
export interface WebAudioDeps {
  call(op: string, a?: unknown, b?: unknown, c?: unknown, d?: unknown): unknown;
  DOMException: unknown;
  EventTarget: unknown;
  /** Sets a target's `on<type>` handler, which takes its place among
   *  its listeners as it is first set (HTML 8.1.8.1). */
  setHandler(target: unknown, type: string, value: unknown): void;
  Event: unknown;
  /** Dispatches an event the user agent fires. */
  fire(target: unknown, event: unknown): void;
  /** A timer the page cannot see or cancel. */
  setTimer(fn: () => void, ms: number): unknown;
  /** Milliseconds, the page's own clock. */
  now(): number;
  /** The page's `MediaStream`. */
  MediaStream: unknown;
  /** Makes a track over a host source (`mediastream.ts`'s internals). */
  track(
    kind: 'audio' | 'video',
    source: number,
    label: string,
    muted: boolean,
  ): unknown;
  isStream(value: unknown): boolean;
  isTrack(value: unknown): boolean;
}

export function installWebAudio(deps: WebAudioDeps): Record<string, unknown> {
  'use strict';
  type Any = any;
  const D: Any = deps;
  const call: Any = D.call;
  const DOMException: Any = D.DOMException;
  const EventTarget: Any = D.EventTarget;
  const setHandler: Any = D.setHandler;
  const Event: Any = D.Event;
  const fire: Any = D.fire;
  const setTimer: Any = D.setTimer;
  const now: () => number = D.now;
  const MediaStream: Any = D.MediaStream;

  const P: Any = Promise;
  const WM: Any = WeakMap;
  const wmGet: Any = WM.prototype.get;
  const wmSet: Any = WM.prototype.set;
  const apply: Any = Reflect.apply;
  const stringify: Any = JSON.stringify;
  const F32: Any = Float32Array;
  const U8: Any = Uint8Array;
  const { floor, max, min, exp, pow, abs } = Math;
  const TOKEN = Object.freeze(Object.create(null));
  /** The largest finite float, which an unbounded parameter is held to. */
  const FLT_MAX = 3.4028234663852886e38;

  const typeError = (message: string): Any => new TypeError(message);
  const rangeError = (message: string): Any => new RangeError(message);
  const domError = (message: string, name: string): Any =>
    new DOMException(message, name);
  const illegal = (): Any => typeError('Illegal invocation');
  const illegalConstructor = (): Any => typeError('Illegal constructor');

  const slots = new WM();
  const slotOf = (self: Any, tag: string): Any => {
    const s =
      self && typeof self === 'object' ? apply(wmGet, slots, [self]) : null;
    if (!s || !s[tag]) throw illegal();
    return s;
  };
  const isA = (v: Any, tag: string): boolean => {
    const s = v && typeof v === 'object' ? apply(wmGet, slots, [v]) : null;
    return !!s?.[tag];
  };

  /** An event handler IDL attribute, which the realm's `EventTarget`
   *  runs from `_handlers` as it dispatches. */
  const handler = (proto: Any, name: string): void => {
    const get = function (this: Any) {
      return this._handlers[name] ?? null;
    };
    const set = function (this: Any, fn: Any) {
      setHandler(
        this,
        name,
        typeof fn === 'function' || (typeof fn === 'object' && fn) ? fn : null,
      );
    };
    Object.defineProperty(get, 'name', { value: `get on${name}` });
    Object.defineProperty(set, 'name', { value: `set on${name}` });
    Object.defineProperty(proto, 'on' + name, {
      get,
      set,
      enumerable: true,
      configurable: true,
    });
  };
  /** Classes made Web IDL interfaces: their members enumerable, as IDL's
   *  are, and their objects' class strings their names. */
  const idl = (classes: Record<string, Any>): void => {
    for (const name of Object.getOwnPropertyNames(classes)) {
      const C = classes[name];
      for (const on of [C.prototype, C]) {
        for (const key of Object.getOwnPropertyNames(on)) {
          if (['constructor', 'prototype', 'length', 'name'].includes(key)) {
            continue;
          }
          const d = Object.getOwnPropertyDescriptor(on, key)!;
          if (d.enumerable || (!d.get && typeof d.value !== 'function')) {
            continue;
          }
          Object.defineProperty(on, key, { ...d, enumerable: true });
        }
      }
      Object.defineProperty(C.prototype, Symbol.toStringTag, {
        value: name,
        configurable: true,
      });
    }
  };
  /** A finite number, as Web IDL's `float` and `double` take one. */
  const finite = (v: Any, what: string): number => {
    const n = +v;
    if (n !== n || n === 1 / 0 || n === -1 / 0) {
      throw typeError(`The provided ${what} is non-finite.`);
    }
    return n;
  };
  const enumOf = (v: Any, values: string[], what: string): string => {
    const s = String(v);
    if (!values.includes(s)) {
      throw typeError(
        `The provided value '${s}' is not a valid enum value of type ${what}.`,
      );
    }
    return s;
  };
  const dict = (v: Any, what: string): Any => {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' && typeof v !== 'function') {
      throw typeError(`The provided value is not of type '${what}'.`);
    }
    return v;
  };
  const contextOf = (v: Any, what: string): Any => {
    if (!isA(v, 'context')) {
      throw typeError(
        `Failed to construct '${what}': parameter 1 is not of type 'BaseAudioContext'.`,
      );
    }
    return apply(wmGet, slots, [v]);
  };

  // --- the clock -------------------------------------------------------------------

  /** A context's time, in render quanta of 128 frames, while it runs. */
  const timeOf = (c: Any): number => {
    if (c.state !== 'running') return c.time;
    const elapsed = (now() - c.since) / 1000;
    const frames = floor((elapsed * c.sampleRate) / 128) * 128;
    return c.time + frames / c.sampleRate;
  };
  /** Stops or starts a context's clock where its state changes. */
  const setState = (c: Any, state: string, told = true): void => {
    if (c.state === state) return;
    c.time = timeOf(c);
    c.since = now();
    c.state = state;
    if (told) fire(c.self, new Event('statechange'));
    for (const node of c.scheduled) scheduleEnd(node);
    renderAll(c);
  };

  // --- parameters --------------------------------------------------------------------

  interface ParamEvent {
    kind: 'set' | 'linear' | 'exponential' | 'target' | 'curve';
    time: number;
    value: number;
    timeConstant?: number;
    curve?: number[];
    duration?: number;
  }

  /** A parameter's value at a time, from its automation (Web Audio 1.6.1.3). */
  const valueAt = (p: Any, t: number): number => {
    let value = p.intrinsic;
    let prev: ParamEvent | null = null;
    let prevValue = value;
    for (let i = 0; i < p.events.length; i++) {
      const e: ParamEvent = p.events[i];
      if (e.time > t) {
        // a ramp reaching past `t` is under way at `t`
        if (e.kind === 'linear' || e.kind === 'exponential') {
          const t0 = prev ? prev.time : 0;
          const v0 = prevValue;
          if (t >= t0 && e.time > t0) {
            const f = (t - t0) / (e.time - t0);
            value =
              e.kind === 'linear'
                ? v0 + (e.value - v0) * f
                : v0 === 0 || v0 * e.value < 0
                  ? v0
                  : v0 * pow(e.value / v0, f);
          }
        }
        break;
      }
      if (e.kind === 'set' || e.kind === 'linear' || e.kind === 'exponential') {
        value = e.value;
      } else if (e.kind === 'target') {
        const next = p.events[i + 1];
        const until = next && next.time <= t ? next.time : t;
        value =
          e.value +
          (prevValue - e.value) *
            exp(-(until - e.time) / (e.timeConstant || 1e-9));
      } else if (e.kind === 'curve') {
        const curve = e.curve!;
        const end = e.time + e.duration!;
        if (t >= end) value = curve[curve.length - 1];
        else {
          const k = ((t - e.time) / e.duration!) * (curve.length - 1);
          const i0 = floor(k);
          value =
            curve[i0] +
            (curve[min(i0 + 1, curve.length - 1)] - curve[i0]) * (k - i0);
        }
      }
      prev = e;
      prevValue = value;
    }
    return min(p.maxValue, max(p.minValue, value));
  };

  const insertEvent = (p: Any, e: ParamEvent): void => {
    const at = p.events.findIndex((x: ParamEvent) => x.time > e.time);
    if (at < 0) p.events.push(e);
    else p.events.splice(at, 0, e);
    p.owner && graphChanged(p.owner.context);
    // the destinations are told again when it comes, as their values move
    const c = p.owner?.context;
    if (c) {
      const due = (e.time - timeOf(c)) * 1000;
      if (due > 0) setTimer(() => graphChanged(c), due);
    }
  };

  class AudioParam {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegalConstructor();
    }
    get value(): number {
      const p = slotOf(this, 'param');
      return valueAt(p, timeOf(p.owner.context));
    }
    set value(v: Any) {
      const p = slotOf(this, 'param');
      const n = finite(v, 'float value');
      p.intrinsic = n;
      // as setValueAtTime(value, currentTime) (Web Audio 1.6.2)
      const t = timeOf(p.owner.context);
      p.events = p.events.filter(
        (e: ParamEvent) => e.time !== t || e.kind !== 'set',
      );
      insertEvent(p, { kind: 'set', time: t, value: n });
    }
    get defaultValue(): number {
      return slotOf(this, 'param').defaultValue;
    }
    get minValue(): number {
      return slotOf(this, 'param').minValue;
    }
    get maxValue(): number {
      return slotOf(this, 'param').maxValue;
    }
    get automationRate(): string {
      return slotOf(this, 'param').rate;
    }
    set automationRate(v: Any) {
      const p = slotOf(this, 'param');
      const rate = enumOf(v, ['a-rate', 'k-rate'], 'AutomationRate');
      if (p.fixedRate && rate !== p.rate) {
        throw domError(
          'This parameter’s automation rate cannot change.',
          'InvalidStateError',
        );
      }
      p.rate = rate;
    }
    setValueAtTime(value: Any, startTime: Any): Any {
      const p = slotOf(this, 'param');
      const v = finite(value, 'float value');
      const t = finite(startTime, 'double value');
      if (t < 0) throw rangeError('startTime must not be negative.');
      insertEvent(p, { kind: 'set', time: t, value: v });
      return this;
    }
    linearRampToValueAtTime(value: Any, endTime: Any): Any {
      const p = slotOf(this, 'param');
      const v = finite(value, 'float value');
      const t = finite(endTime, 'double value');
      if (t < 0) throw rangeError('endTime must not be negative.');
      insertEvent(p, { kind: 'linear', time: t, value: v });
      return this;
    }
    exponentialRampToValueAtTime(value: Any, endTime: Any): Any {
      const p = slotOf(this, 'param');
      const v = finite(value, 'float value');
      const t = finite(endTime, 'double value');
      if (v === 0) throw rangeError('An exponential ramp cannot reach 0.');
      if (t < 0) throw rangeError('endTime must not be negative.');
      insertEvent(p, { kind: 'exponential', time: t, value: v });
      return this;
    }
    setTargetAtTime(target: Any, startTime: Any, timeConstant: Any): Any {
      const p = slotOf(this, 'param');
      const v = finite(target, 'float value');
      const t = finite(startTime, 'double value');
      const k = finite(timeConstant, 'float value');
      if (t < 0) throw rangeError('startTime must not be negative.');
      if (k < 0) throw rangeError('timeConstant must not be negative.');
      insertEvent(p, { kind: 'target', time: t, value: v, timeConstant: k });
      return this;
    }
    setValueCurveAtTime(values: Any, startTime: Any, duration: Any): Any {
      const p = slotOf(this, 'param');
      if (!values || typeof values[Symbol.iterator] !== 'function') {
        throw typeError('The provided values are not a sequence.');
      }
      const curve = [...values].map((x: Any) => finite(x, 'float value'));
      const t = finite(startTime, 'double value');
      const d = finite(duration, 'double value');
      if (curve.length < 2) {
        throw domError(
          'A curve needs at least two values.',
          'InvalidStateError',
        );
      }
      if (t < 0) throw rangeError('startTime must not be negative.');
      if (d <= 0) throw rangeError('duration must be positive.');
      const end = t + d;
      if (p.events.some((e: ParamEvent) => e.time > t && e.time < end)) {
        throw domError(
          'The curve overlaps an event already scheduled.',
          'NotSupportedError',
        );
      }
      insertEvent(p, {
        kind: 'curve',
        time: t,
        value: curve[curve.length - 1],
        curve,
        duration: d,
      });
      return this;
    }
    cancelScheduledValues(cancelTime: Any): Any {
      const p = slotOf(this, 'param');
      const t = finite(cancelTime, 'double value');
      if (t < 0) throw rangeError('cancelTime must not be negative.');
      p.events = p.events.filter((e: ParamEvent) => e.time < t);
      graphChanged(p.owner.context);
      return this;
    }
    cancelAndHoldAtTime(cancelTime: Any): Any {
      const p = slotOf(this, 'param');
      const t = finite(cancelTime, 'double value');
      if (t < 0) throw rangeError('cancelTime must not be negative.');
      const held = valueAt(p, t);
      p.events = p.events.filter((e: ParamEvent) => e.time < t);
      p.events.push({ kind: 'set', time: t, value: held });
      graphChanged(p.owner.context);
      return this;
    }
  }

  const param = (
    owner: Any,
    value: number,
    minValue = -FLT_MAX,
    maxValue = FLT_MAX,
    rate = 'a-rate',
    fixedRate = false,
  ): Any => {
    const self = new AudioParam(TOKEN);
    apply(wmSet, slots, [
      self,
      {
        param: true,
        owner,
        intrinsic: value,
        defaultValue: value,
        minValue,
        maxValue,
        rate,
        fixedRate,
        events: [] as ParamEvent[],
      },
    ]);
    return self;
  };
  const paramSlot = (p: Any): Any => apply(wmGet, slots, [p]);

  // --- nodes ------------------------------------------------------------------------

  interface NodeShape {
    inputs: number;
    outputs: number;
    channelCount: number;
    mode: string;
    interpretation: string;
    /** What a channel count may be set to: a fixed one, or at most. */
    fixedCount?: boolean;
    maxCount?: number;
    fixedMode?: boolean;
  }

  class AudioNode extends EventTarget {
    constructor(token: Any = undefined) {
      super();
      if (token !== TOKEN) throw illegalConstructor();
    }
    get context(): Any {
      return slotOf(this, 'node').context.self;
    }
    get numberOfInputs(): number {
      return slotOf(this, 'node').shape.inputs;
    }
    get numberOfOutputs(): number {
      return slotOf(this, 'node').shape.outputs;
    }
    get channelCount(): number {
      return slotOf(this, 'node').count;
    }
    set channelCount(v: Any) {
      const n = slotOf(this, 'node');
      const count = +v >>> 0;
      if (count === 0 || count > 32) {
        throw domError(
          'channelCount must be from 1 to 32.',
          'NotSupportedError',
        );
      }
      if (n.shape.fixedCount && count !== n.count) {
        throw domError(
          `This node’s channelCount is ${n.count} and cannot change.`,
          n.shape.inputs === 0 ? 'InvalidStateError' : 'NotSupportedError',
        );
      }
      if (n.shape.maxCount && count > n.shape.maxCount) {
        throw domError(
          `This node’s channelCount is at most ${n.shape.maxCount}.`,
          'NotSupportedError',
        );
      }
      n.count = count;
    }
    get channelCountMode(): string {
      return slotOf(this, 'node').mode;
    }
    set channelCountMode(v: Any) {
      const n = slotOf(this, 'node');
      let mode: string;
      try {
        mode = enumOf(
          v,
          ['max', 'clamped-max', 'explicit'],
          'ChannelCountMode',
        );
      } catch {
        return;
      }
      if (n.shape.fixedMode && mode !== n.mode) {
        throw domError(
          'This node’s channelCountMode cannot change.',
          'NotSupportedError',
        );
      }
      n.mode = mode;
    }
    get channelInterpretation(): string {
      return slotOf(this, 'node').interpretation;
    }
    set channelInterpretation(v: Any) {
      const n = slotOf(this, 'node');
      try {
        n.interpretation = enumOf(
          v,
          ['speakers', 'discrete'],
          'ChannelInterpretation',
        );
      } catch {
        // an invalid enum value is ignored, as a setter's is
      }
    }
    connect(destination: Any, output: Any = 0, input: Any = 0): Any {
      const n = slotOf(this, 'node');
      const out = +output >>> 0;
      if (out >= n.shape.outputs) {
        throw domError('The output index is out of range.', 'IndexSizeError');
      }
      if (isA(destination, 'param')) {
        const p = paramSlot(destination);
        if (p.owner.context !== n.context) {
          throw domError(
            'The parameter is another context’s.',
            'InvalidAccessError',
          );
        }
        n.connections.push({ to: p, output: out, input: -1 });
        graphChanged(n.context);
        return undefined;
      }
      if (!isA(destination, 'node')) {
        throw typeError(
          "Failed to execute 'connect' on 'AudioNode': parameter 1 is not of type 'AudioNode'.",
        );
      }
      const d = apply(wmGet, slots, [destination]);
      if (d.context !== n.context) {
        throw domError('The node is another context’s.', 'InvalidAccessError');
      }
      const inp = +input >>> 0;
      if (inp >= d.shape.inputs) {
        throw domError('The input index is out of range.', 'IndexSizeError');
      }
      if (
        !n.connections.some(
          (c: Any) => c.to === d && c.output === out && c.input === inp,
        )
      ) {
        n.connections.push({ to: d, output: out, input: inp });
      }
      if (!n.ended) d.inputs.add(n);
      graphChanged(n.context);
      return destination;
    }
    disconnect(
      destinationOrOutput: Any = undefined,
      output: Any = undefined,
      input: Any = undefined,
    ): void {
      const n = slotOf(this, 'node');
      const before: Any[] = n.connections;
      if (destinationOrOutput === undefined) {
        n.connections = [];
      } else if (typeof destinationOrOutput === 'number') {
        const out = destinationOrOutput >>> 0;
        if (out >= n.shape.outputs) {
          throw domError('The output index is out of range.', 'IndexSizeError');
        }
        n.connections = n.connections.filter((c: Any) => c.output !== out);
      } else {
        const to =
          isA(destinationOrOutput, 'node') || isA(destinationOrOutput, 'param')
            ? apply(wmGet, slots, [destinationOrOutput])
            : null;
        if (!to)
          throw typeError(
            'The destination is not an AudioNode or an AudioParam.',
          );
        const matches = (c: Any) =>
          c.to === to &&
          (output === undefined || c.output === +output >>> 0) &&
          (input === undefined || c.input === +input >>> 0);
        if (!n.connections.some(matches)) {
          throw domError(
            'The node is not connected to it.',
            'InvalidAccessError',
          );
        }
        n.connections = n.connections.filter((c: Any) => !matches(c));
      }
      for (const link of before) {
        if (
          link.to.inputs &&
          !n.connections.some((c: Any) => c.to === link.to)
        ) {
          link.to.inputs.delete(n);
        }
      }
      graphChanged(n.context);
    }
  }

  /** A node of a context: its shape, and its connections out. */
  const makeNode = (
    self: Any,
    c: Any,
    shape: NodeShape,
    extra: Any = {},
  ): Any => {
    const n = {
      node: true,
      self,
      context: c,
      shape,
      count: shape.channelCount,
      mode: shape.mode,
      interpretation: shape.interpretation,
      connections: [] as Any[],
      /** The nodes connected to it, which a destination's graph is walked
       *  back over: a node nothing reaches is no one's to keep. */
      inputs: new Set<Any>(),
      ...extra,
    };
    apply(wmSet, slots, [self, n]);
    return n;
  };
  /** The channel options a node's constructor takes (Web Audio 1.5.2). */
  const channelOptions = (self: Any, o: Any): void => {
    if (o.channelCount !== undefined) self.channelCount = o.channelCount;
    if (o.channelCountMode !== undefined) {
      const n = apply(wmGet, slots, [self]);
      const mode = enumOf(
        o.channelCountMode,
        ['max', 'clamped-max', 'explicit'],
        'ChannelCountMode',
      );
      if (n.shape.fixedMode && mode !== n.mode) {
        throw domError(
          'This node’s channelCountMode cannot change.',
          'NotSupportedError',
        );
      }
      n.mode = mode;
    }
    if (o.channelInterpretation !== undefined) {
      apply(wmGet, slots, [self]).interpretation = enumOf(
        o.channelInterpretation,
        ['speakers', 'discrete'],
        'ChannelInterpretation',
      );
    }
  };
  const SHAPE = (
    inputs: number,
    outputs: number,
    count = 2,
    mode = 'max',
    more: Any = {},
  ): NodeShape => ({
    inputs,
    outputs,
    channelCount: count,
    mode,
    interpretation: 'speakers',
    ...more,
  });

  // --- scheduled sources -------------------------------------------------------------

  /** Fires `ended` at a source's end, once the context's clock gets there. */
  const scheduleEnd = (n: Any): void => {
    const c = n.context;
    if (n.ended || n.start === null || c.state !== 'running') return;
    const end = n.stop ?? n.natural?.();
    if (end === null || end === undefined) return;
    const due = (end - timeOf(c)) * 1000;
    const serial = ++n.serial;
    setTimer(
      () => {
        if (serial !== n.serial || n.ended || c.state !== 'running') return;
        if (timeOf(c) + 1e-9 < end) {
          scheduleEnd(n);
          return;
        }
        n.ended = true;
        c.scheduled.delete(n);
        // what it was connected to no longer hears it, nor keeps it
        for (const link of n.connections) link.to.inputs?.delete(n);
        graphChanged(c);
        fire(n.self, new Event('ended'));
      },
      max(0, due),
    );
  };

  class AudioScheduledSourceNode extends AudioNode {
    start(when: Any = 0): void {
      const n = slotOf(this, 'scheduled');
      const t = finite(when, 'double value');
      if (n.start !== null) {
        throw domError('start() may be called only once.', 'InvalidStateError');
      }
      if (t < 0) throw rangeError('when must not be negative.');
      n.start = t;
      n.context.scheduled.add(n);
      scheduleEnd(n);
      graphChanged(n.context);
    }
    stop(when: Any = 0): void {
      const n = slotOf(this, 'scheduled');
      const t = finite(when, 'double value');
      if (n.start === null) {
        throw domError('stop() needs start() first.', 'InvalidStateError');
      }
      if (t < 0) throw rangeError('when must not be negative.');
      n.stop = max(t, n.start);
      scheduleEnd(n);
      graphChanged(n.context);
    }
  }
  handler(AudioScheduledSourceNode.prototype, 'ended');
  const scheduledExtra = () => ({
    scheduled: true,
    start: null,
    stop: null,
    ended: false,
    serial: 0,
  });

  const OSCILLATOR_TYPES = ['sine', 'square', 'sawtooth', 'triangle', 'custom'];

  class OscillatorNode extends AudioScheduledSourceNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'OscillatorNode');
      const o = dict(options, 'OscillatorOptions');
      const type =
        o.type === undefined
          ? 'sine'
          : enumOf(o.type, OSCILLATOR_TYPES, 'OscillatorType');
      if (type === 'custom' && !o.periodicWave) {
        throw domError(
          'A custom oscillator needs a periodicWave.',
          'InvalidStateError',
        );
      }
      const nyquist = c.sampleRate / 2;
      const n = makeNode(this, c, SHAPE(0, 1), {
        ...scheduledExtra(),
        oscillator: true,
        type,
        wave: null,
      });
      n.frequency = param(
        n,
        o.frequency === undefined ? 440 : finite(o.frequency, 'float value'),
        -nyquist,
        nyquist,
      );
      n.detune = param(
        n,
        o.detune === undefined ? 0 : finite(o.detune, 'float value'),
        -153600,
        153600,
      );
      if (o.periodicWave) this.setPeriodicWave(o.periodicWave);
      channelOptions(this, o);
    }
    get type(): string {
      return slotOf(this, 'oscillator').type;
    }
    set type(v: Any) {
      const n = slotOf(this, 'oscillator');
      let type: string;
      try {
        type = enumOf(v, OSCILLATOR_TYPES, 'OscillatorType');
      } catch {
        return;
      }
      if (type === 'custom') {
        throw domError(
          'Use setPeriodicWave() for a custom oscillator.',
          'InvalidStateError',
        );
      }
      n.type = type;
      n.wave = null;
      graphChanged(n.context);
    }
    get frequency(): Any {
      return slotOf(this, 'oscillator').frequency;
    }
    get detune(): Any {
      return slotOf(this, 'oscillator').detune;
    }
    setPeriodicWave(wave: Any): void {
      const n = slotOf(this, 'oscillator');
      if (!isA(wave, 'wave')) {
        throw typeError(
          "Failed to execute 'setPeriodicWave' on 'OscillatorNode': parameter 1 is not of type 'PeriodicWave'.",
        );
      }
      n.type = 'custom';
      n.wave = apply(wmGet, slots, [wave]);
      graphChanged(n.context);
    }
  }

  class ConstantSourceNode extends AudioScheduledSourceNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'ConstantSourceNode');
      const o = dict(options, 'ConstantSourceOptions');
      const n = makeNode(this, c, SHAPE(0, 1), {
        ...scheduledExtra(),
        constant: true,
      });
      n.offset = param(
        n,
        o.offset === undefined ? 1 : finite(o.offset, 'float value'),
      );
    }
    get offset(): Any {
      return slotOf(this, 'constant').offset;
    }
  }

  class AudioBufferSourceNode extends AudioScheduledSourceNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'AudioBufferSourceNode');
      const o = dict(options, 'AudioBufferSourceOptions');
      const n = makeNode(this, c, SHAPE(0, 1), {
        ...scheduledExtra(),
        bufferSource: true,
        buffer: null,
        bufferSet: false,
        loop: !!o.loop,
        loopStart:
          o.loopStart === undefined ? 0 : finite(o.loopStart, 'double value'),
        loopEnd:
          o.loopEnd === undefined ? 0 : finite(o.loopEnd, 'double value'),
        offset: 0,
        length: null,
      });
      n.playbackRate = param(
        n,
        o.playbackRate === undefined
          ? 1
          : finite(o.playbackRate, 'float value'),
        -FLT_MAX,
        FLT_MAX,
        'k-rate',
        true,
      );
      n.detune = param(
        n,
        o.detune === undefined ? 0 : finite(o.detune, 'float value'),
        -FLT_MAX,
        FLT_MAX,
        'k-rate',
        true,
      );
      // when a source with a buffer and no loop runs out of it
      n.natural = () => {
        if (!n.buffer || n.loop) return null;
        const b = apply(wmGet, slots, [n.buffer]);
        const rate = abs(valueAt(paramSlot(n.playbackRate), timeOf(c))) || 1;
        const seconds = n.length ?? max(0, b.length / b.sampleRate - n.offset);
        return n.start + seconds / rate;
      };
      if (o.buffer !== undefined && o.buffer !== null) this.buffer = o.buffer;
    }
    get buffer(): Any {
      return slotOf(this, 'bufferSource').buffer;
    }
    set buffer(v: Any) {
      const n = slotOf(this, 'bufferSource');
      if (v !== null && !isA(v, 'audioBuffer')) {
        throw typeError("The provided value is not of type 'AudioBuffer'.");
      }
      if (v !== null && n.bufferSet) {
        throw domError('The buffer can be set only once.', 'InvalidStateError');
      }
      if (v !== null) n.bufferSet = true;
      n.buffer = v;
      scheduleEnd(n);
    }
    get playbackRate(): Any {
      return slotOf(this, 'bufferSource').playbackRate;
    }
    get detune(): Any {
      return slotOf(this, 'bufferSource').detune;
    }
    get loop(): boolean {
      return slotOf(this, 'bufferSource').loop;
    }
    set loop(v: Any) {
      const n = slotOf(this, 'bufferSource');
      n.loop = !!v;
      scheduleEnd(n);
    }
    get loopStart(): number {
      return slotOf(this, 'bufferSource').loopStart;
    }
    set loopStart(v: Any) {
      slotOf(this, 'bufferSource').loopStart = finite(v, 'double value');
    }
    get loopEnd(): number {
      return slotOf(this, 'bufferSource').loopEnd;
    }
    set loopEnd(v: Any) {
      slotOf(this, 'bufferSource').loopEnd = finite(v, 'double value');
    }
    override start(
      when: Any = 0,
      offset: Any = undefined,
      duration: Any = undefined,
    ): void {
      const n = slotOf(this, 'bufferSource');
      if (offset !== undefined) {
        const o = finite(offset, 'double value');
        if (o < 0) throw rangeError('offset must not be negative.');
        n.offset = o;
      }
      if (duration !== undefined) {
        const d = finite(duration, 'double value');
        if (d < 0) throw rangeError('duration must not be negative.');
        n.length = d;
      }
      super.start(when);
    }
  }

  class GainNode extends AudioNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'GainNode');
      const o = dict(options, 'GainOptions');
      const n = makeNode(this, c, SHAPE(1, 1), { gainNode: true });
      n.gain = param(
        n,
        o.gain === undefined ? 1 : finite(o.gain, 'float value'),
      );
      channelOptions(this, o);
    }
    get gain(): Any {
      return slotOf(this, 'gainNode').gain;
    }
  }

  class DelayNode extends AudioNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'DelayNode');
      const o = dict(options, 'DelayOptions');
      const maxDelay =
        o.maxDelayTime === undefined
          ? 1
          : finite(o.maxDelayTime, 'double value');
      if (maxDelay <= 0 || maxDelay >= 180) {
        throw domError(
          'maxDelayTime must be above 0 and below 180.',
          'NotSupportedError',
        );
      }
      const n = makeNode(this, c, SHAPE(1, 1), { delayNode: true });
      n.delayTime = param(
        n,
        o.delayTime === undefined ? 0 : finite(o.delayTime, 'float value'),
        0,
        maxDelay,
      );
      channelOptions(this, o);
    }
    get delayTime(): Any {
      return slotOf(this, 'delayNode').delayTime;
    }
  }

  const BIQUAD_TYPES = [
    'lowpass',
    'highpass',
    'bandpass',
    'lowshelf',
    'highshelf',
    'peaking',
    'notch',
    'allpass',
  ];

  class BiquadFilterNode extends AudioNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'BiquadFilterNode');
      const o = dict(options, 'BiquadFilterOptions');
      const nyquist = c.sampleRate / 2;
      const n = makeNode(this, c, SHAPE(1, 1), {
        biquad: true,
        type:
          o.type === undefined
            ? 'lowpass'
            : enumOf(o.type, BIQUAD_TYPES, 'BiquadFilterType'),
      });
      n.frequency = param(
        n,
        o.frequency === undefined ? 350 : finite(o.frequency, 'float value'),
        0,
        nyquist,
      );
      n.detune = param(
        n,
        o.detune === undefined ? 0 : finite(o.detune, 'float value'),
        -153600,
        153600,
      );
      n.Q = param(n, o.Q === undefined ? 1 : finite(o.Q, 'float value'));
      n.gain = param(
        n,
        o.gain === undefined ? 0 : finite(o.gain, 'float value'),
        -FLT_MAX,
        1541,
      );
      channelOptions(this, o);
    }
    get type(): string {
      return slotOf(this, 'biquad').type;
    }
    set type(v: Any) {
      try {
        slotOf(this, 'biquad').type = enumOf(
          v,
          BIQUAD_TYPES,
          'BiquadFilterType',
        );
      } catch {
        // ignored, as an invalid enum value's set is
      }
    }
    get frequency(): Any {
      return slotOf(this, 'biquad').frequency;
    }
    get detune(): Any {
      return slotOf(this, 'biquad').detune;
    }
    get Q(): Any {
      return slotOf(this, 'biquad').Q;
    }
    get gain(): Any {
      return slotOf(this, 'biquad').gain;
    }
    /** The filter's response at each frequency (Web Audio 1.13.6), from
     *  the Audio EQ Cookbook's coefficients, as a browser works it out. */
    getFrequencyResponse(
      frequencyHz: Any,
      magResponse: Any,
      phaseResponse: Any,
    ): void {
      const n = slotOf(this, 'biquad');
      for (const a of [frequencyHz, magResponse, phaseResponse]) {
        if (!(a instanceof F32))
          throw typeError('The arrays must be Float32Arrays.');
      }
      if (
        magResponse.length !== frequencyHz.length ||
        phaseResponse.length !== frequencyHz.length
      ) {
        throw domError(
          'The arrays must be of one length.',
          'InvalidAccessError',
        );
      }
      const t = timeOf(n.context);
      const fs = n.context.sampleRate;
      const f0 =
        valueAt(paramSlot(n.frequency), t) *
        pow(2, valueAt(paramSlot(n.detune), t) / 1200);
      const Q = valueAt(paramSlot(n.Q), t);
      const G = valueAt(paramSlot(n.gain), t);
      const A = pow(10, G / 40);
      const w0 = (2 * Math.PI * f0) / fs;
      const cw = Math.cos(w0);
      const sw = Math.sin(w0);
      const aQ = sw / (2 * (Q || 1e-9));
      const aQdB = sw / (2 * pow(10, Q / 20));
      const S = 1;
      const aS = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
      let b0 = 1,
        b1 = 0,
        b2 = 0,
        a0 = 1,
        a1 = 0,
        a2 = 0;
      switch (n.type) {
        case 'lowpass':
          b0 = (1 - cw) / 2;
          b1 = 1 - cw;
          b2 = b0;
          a0 = 1 + aQdB;
          a1 = -2 * cw;
          a2 = 1 - aQdB;
          break;
        case 'highpass':
          b0 = (1 + cw) / 2;
          b1 = -(1 + cw);
          b2 = b0;
          a0 = 1 + aQdB;
          a1 = -2 * cw;
          a2 = 1 - aQdB;
          break;
        case 'bandpass':
          b0 = aQ;
          b1 = 0;
          b2 = -aQ;
          a0 = 1 + aQ;
          a1 = -2 * cw;
          a2 = 1 - aQ;
          break;
        case 'notch':
          b0 = 1;
          b1 = -2 * cw;
          b2 = 1;
          a0 = 1 + aQ;
          a1 = -2 * cw;
          a2 = 1 - aQ;
          break;
        case 'allpass':
          b0 = 1 - aQ;
          b1 = -2 * cw;
          b2 = 1 + aQ;
          a0 = 1 + aQ;
          a1 = -2 * cw;
          a2 = 1 - aQ;
          break;
        case 'peaking':
          b0 = 1 + aQ * A;
          b1 = -2 * cw;
          b2 = 1 - aQ * A;
          a0 = 1 + aQ / A;
          a1 = -2 * cw;
          a2 = 1 - aQ / A;
          break;
        case 'lowshelf': {
          const k = 2 * Math.sqrt(A) * aS;
          b0 = A * (A + 1 - (A - 1) * cw + k);
          b1 = 2 * A * (A - 1 - (A + 1) * cw);
          b2 = A * (A + 1 - (A - 1) * cw - k);
          a0 = A + 1 + (A - 1) * cw + k;
          a1 = -2 * (A - 1 + (A + 1) * cw);
          a2 = A + 1 + (A - 1) * cw - k;
          break;
        }
        case 'highshelf': {
          const k = 2 * Math.sqrt(A) * aS;
          b0 = A * (A + 1 + (A - 1) * cw + k);
          b1 = -2 * A * (A - 1 + (A + 1) * cw);
          b2 = A * (A + 1 + (A - 1) * cw - k);
          a0 = A + 1 - (A - 1) * cw + k;
          a1 = 2 * (A - 1 - (A + 1) * cw);
          a2 = A + 1 - (A - 1) * cw - k;
          break;
        }
      }
      responseOf(
        [b0 / a0, b1 / a0, b2 / a0],
        [1, a1 / a0, a2 / a0],
        fs,
        frequencyHz,
        magResponse,
        phaseResponse,
      );
    }
  }

  /** A filter's response, from its coefficients, at each frequency: NaN
   *  outside 0 to Nyquist. */
  const responseOf = (
    b: number[],
    a: number[],
    fs: number,
    freq: Any,
    mag: Any,
    phase: Any,
  ): void => {
    for (let i = 0; i < freq.length; i++) {
      const f = freq[i];
      if (!(f >= 0 && f <= fs / 2)) {
        mag[i] = NaN;
        phase[i] = NaN;
        continue;
      }
      const w = (2 * Math.PI * f) / fs;
      let nr = 0,
        ni = 0,
        dr = 0,
        di = 0;
      for (let k = 0; k < b.length; k++) {
        nr += b[k] * Math.cos(-k * w);
        ni += b[k] * Math.sin(-k * w);
      }
      for (let k = 0; k < a.length; k++) {
        dr += a[k] * Math.cos(-k * w);
        di += a[k] * Math.sin(-k * w);
      }
      const d = dr * dr + di * di;
      const re = (nr * dr + ni * di) / d;
      const im = (ni * dr - nr * di) / d;
      mag[i] = Math.sqrt(re * re + im * im);
      phase[i] = Math.atan2(im, re);
    }
  };

  class IIRFilterNode extends AudioNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'IIRFilterNode');
      const o = dict(options, 'IIRFilterOptions');
      const list = (v: Any, what: string): number[] => {
        if (!v || typeof v[Symbol.iterator] !== 'function') {
          throw typeError(
            `Failed to construct 'IIRFilterNode': required member ${what} is undefined.`,
          );
        }
        return [...v].map((x: Any) => finite(x, 'double value'));
      };
      const feedforward = list(o.feedforward, 'feedforward');
      const feedback = list(o.feedback, 'feedback');
      if (
        !feedforward.length ||
        feedforward.length > 20 ||
        !feedback.length ||
        feedback.length > 20
      ) {
        throw domError(
          'Each coefficient list has 1 to 20 values.',
          'NotSupportedError',
        );
      }
      if (feedforward.every((x) => x === 0)) {
        throw domError(
          'The feedforward coefficients cannot all be 0.',
          'InvalidStateError',
        );
      }
      if (feedback[0] === 0) {
        throw domError(
          'The first feedback coefficient cannot be 0.',
          'InvalidStateError',
        );
      }
      makeNode(this, c, SHAPE(1, 1), { iir: true, feedforward, feedback });
      channelOptions(this, o);
    }
    getFrequencyResponse(
      frequencyHz: Any,
      magResponse: Any,
      phaseResponse: Any,
    ): void {
      const n = slotOf(this, 'iir');
      for (const a of [frequencyHz, magResponse, phaseResponse]) {
        if (!(a instanceof F32))
          throw typeError('The arrays must be Float32Arrays.');
      }
      if (
        magResponse.length !== frequencyHz.length ||
        phaseResponse.length !== frequencyHz.length
      ) {
        throw domError(
          'The arrays must be of one length.',
          'InvalidAccessError',
        );
      }
      const a0 = n.feedback[0];
      responseOf(
        n.feedforward.map((x: number) => x / a0),
        n.feedback.map((x: number) => x / a0),
        n.context.sampleRate,
        frequencyHz,
        magResponse,
        phaseResponse,
      );
    }
  }

  class WaveShaperNode extends AudioNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'WaveShaperNode');
      const o = dict(options, 'WaveShaperOptions');
      makeNode(this, c, SHAPE(1, 1), {
        shaper: true,
        curve: null,
        oversample:
          o.oversample === undefined
            ? 'none'
            : enumOf(o.oversample, ['none', '2x', '4x'], 'OverSampleType'),
      });
      if (o.curve !== undefined && o.curve !== null) this.curve = o.curve;
      channelOptions(this, o);
    }
    get curve(): Any {
      return slotOf(this, 'shaper').curve;
    }
    set curve(v: Any) {
      const n = slotOf(this, 'shaper');
      if (v === null) {
        n.curve = null;
        return;
      }
      if (!v || typeof v[Symbol.iterator] !== 'function') {
        throw typeError("The provided value is not of type 'Float32Array'.");
      }
      const curve = new F32([...v]);
      if (curve.length < 2) {
        throw domError(
          'A curve needs at least two values.',
          'InvalidStateError',
        );
      }
      if (n.curve !== null) {
        throw domError('The curve can be set only once.', 'InvalidStateError');
      }
      n.curve = curve;
    }
    get oversample(): string {
      return slotOf(this, 'shaper').oversample;
    }
    set oversample(v: Any) {
      try {
        slotOf(this, 'shaper').oversample = enumOf(
          v,
          ['none', '2x', '4x'],
          'OverSampleType',
        );
      } catch {
        // ignored
      }
    }
  }

  class DynamicsCompressorNode extends AudioNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'DynamicsCompressorNode');
      const o = dict(options, 'DynamicsCompressorOptions');
      const n = makeNode(
        this,
        c,
        SHAPE(1, 1, 2, 'clamped-max', { maxCount: 2 }),
        { compressor: true },
      );
      const opt = (k: string, d: number) =>
        o[k] === undefined ? d : finite(o[k], 'float value');
      n.threshold = param(n, opt('threshold', -24), -100, 0, 'k-rate', true);
      n.knee = param(n, opt('knee', 30), 0, 40, 'k-rate', true);
      n.ratio = param(n, opt('ratio', 12), 1, 20, 'k-rate', true);
      n.attack = param(n, opt('attack', 0.003), 0, 1, 'k-rate', true);
      n.release = param(n, opt('release', 0.25), 0, 1, 'k-rate', true);
      channelOptions(this, o);
    }
    get threshold(): Any {
      return slotOf(this, 'compressor').threshold;
    }
    get knee(): Any {
      return slotOf(this, 'compressor').knee;
    }
    get ratio(): Any {
      return slotOf(this, 'compressor').ratio;
    }
    get attack(): Any {
      return slotOf(this, 'compressor').attack;
    }
    get release(): Any {
      return slotOf(this, 'compressor').release;
    }
    /** The gain it takes off, in dB: none, as it hears nothing. */
    get reduction(): number {
      slotOf(this, 'compressor');
      return 0;
    }
  }

  class StereoPannerNode extends AudioNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'StereoPannerNode');
      const o = dict(options, 'StereoPannerOptions');
      const n = makeNode(
        this,
        c,
        SHAPE(1, 1, 2, 'clamped-max', { maxCount: 2 }),
        { stereo: true },
      );
      n.pan = param(
        n,
        o.pan === undefined ? 0 : finite(o.pan, 'float value'),
        -1,
        1,
      );
      channelOptions(this, o);
    }
    get pan(): Any {
      return slotOf(this, 'stereo').pan;
    }
  }

  class PannerNode extends AudioNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'PannerNode');
      const o = dict(options, 'PannerOptions');
      const n = makeNode(
        this,
        c,
        SHAPE(1, 1, 2, 'clamped-max', { maxCount: 2 }),
        {
          panner: true,
          panningModel:
            o.panningModel === undefined
              ? 'equalpower'
              : enumOf(
                  o.panningModel,
                  ['equalpower', 'HRTF'],
                  'PanningModelType',
                ),
          distanceModel:
            o.distanceModel === undefined
              ? 'inverse'
              : enumOf(
                  o.distanceModel,
                  ['linear', 'inverse', 'exponential'],
                  'DistanceModelType',
                ),
          refDistance: 1,
          maxDistance: 10000,
          rolloffFactor: 1,
          coneInnerAngle: 360,
          coneOuterAngle: 360,
          coneOuterGain: 0,
        },
      );
      const opt = (k: string, d: number) =>
        o[k] === undefined ? d : finite(o[k], 'float value');
      for (const [k, d] of [
        ['positionX', 0],
        ['positionY', 0],
        ['positionZ', 0],
        ['orientationX', 1],
        ['orientationY', 0],
        ['orientationZ', 0],
      ] as [string, number][]) {
        n[k] = param(n, opt(k, d));
      }
      for (const k of [
        'refDistance',
        'maxDistance',
        'rolloffFactor',
        'coneInnerAngle',
        'coneOuterAngle',
        'coneOuterGain',
      ]) {
        if (o[k] !== undefined) (this as Any)[k] = o[k];
      }
      channelOptions(this, o);
    }
    get panningModel(): string {
      return slotOf(this, 'panner').panningModel;
    }
    set panningModel(v: Any) {
      try {
        slotOf(this, 'panner').panningModel = enumOf(
          v,
          ['equalpower', 'HRTF'],
          'PanningModelType',
        );
      } catch {
        // ignored
      }
    }
    get distanceModel(): string {
      return slotOf(this, 'panner').distanceModel;
    }
    set distanceModel(v: Any) {
      try {
        slotOf(this, 'panner').distanceModel = enumOf(
          v,
          ['linear', 'inverse', 'exponential'],
          'DistanceModelType',
        );
      } catch {
        // ignored
      }
    }
    get positionX(): Any {
      return slotOf(this, 'panner').positionX;
    }
    get positionY(): Any {
      return slotOf(this, 'panner').positionY;
    }
    get positionZ(): Any {
      return slotOf(this, 'panner').positionZ;
    }
    get orientationX(): Any {
      return slotOf(this, 'panner').orientationX;
    }
    get orientationY(): Any {
      return slotOf(this, 'panner').orientationY;
    }
    get orientationZ(): Any {
      return slotOf(this, 'panner').orientationZ;
    }
    get refDistance(): number {
      return slotOf(this, 'panner').refDistance;
    }
    set refDistance(v: Any) {
      const d = finite(v, 'double value');
      if (d < 0) throw rangeError('refDistance must not be negative.');
      slotOf(this, 'panner').refDistance = d;
    }
    get maxDistance(): number {
      return slotOf(this, 'panner').maxDistance;
    }
    set maxDistance(v: Any) {
      const d = finite(v, 'double value');
      if (d <= 0) throw rangeError('maxDistance must be positive.');
      slotOf(this, 'panner').maxDistance = d;
    }
    get rolloffFactor(): number {
      return slotOf(this, 'panner').rolloffFactor;
    }
    set rolloffFactor(v: Any) {
      const d = finite(v, 'double value');
      if (d < 0) throw rangeError('rolloffFactor must not be negative.');
      slotOf(this, 'panner').rolloffFactor = d;
    }
    get coneInnerAngle(): number {
      return slotOf(this, 'panner').coneInnerAngle;
    }
    set coneInnerAngle(v: Any) {
      slotOf(this, 'panner').coneInnerAngle = finite(v, 'double value');
    }
    get coneOuterAngle(): number {
      return slotOf(this, 'panner').coneOuterAngle;
    }
    set coneOuterAngle(v: Any) {
      slotOf(this, 'panner').coneOuterAngle = finite(v, 'double value');
    }
    get coneOuterGain(): number {
      return slotOf(this, 'panner').coneOuterGain;
    }
    set coneOuterGain(v: Any) {
      const d = finite(v, 'double value');
      if (d < 0 || d > 1)
        throw domError(
          'coneOuterGain must be from 0 to 1.',
          'InvalidStateError',
        );
      slotOf(this, 'panner').coneOuterGain = d;
    }
    setPosition(x: Any, y: Any, z: Any): void {
      const n = slotOf(this, 'panner');
      this.positionX.value = x;
      this.positionY.value = y;
      this.positionZ.value = z;
      graphChanged(n.context);
    }
    setOrientation(x: Any, y: Any, z: Any): void {
      this.orientationX.value = x;
      this.orientationY.value = y;
      this.orientationZ.value = z;
    }
  }

  class ChannelMergerNode extends AudioNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'ChannelMergerNode');
      const o = dict(options, 'ChannelMergerOptions');
      const inputs =
        o.numberOfInputs === undefined ? 6 : +o.numberOfInputs >>> 0;
      if (inputs < 1 || inputs > 32) {
        throw domError(
          'numberOfInputs must be from 1 to 32.',
          'IndexSizeError',
        );
      }
      makeNode(
        this,
        c,
        SHAPE(inputs, 1, 1, 'explicit', { fixedCount: true, fixedMode: true }),
        { merger: true },
      );
      channelOptions(this, o);
    }
  }

  class ChannelSplitterNode extends AudioNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'ChannelSplitterNode');
      const o = dict(options, 'ChannelSplitterOptions');
      const outputs =
        o.numberOfOutputs === undefined ? 6 : +o.numberOfOutputs >>> 0;
      if (outputs < 1 || outputs > 32) {
        throw domError(
          'numberOfOutputs must be from 1 to 32.',
          'IndexSizeError',
        );
      }
      makeNode(
        this,
        c,
        SHAPE(1, outputs, outputs, 'explicit', {
          fixedCount: true,
          fixedMode: true,
        }),
        {
          splitter: true,
        },
      );
      channelOptions(this, o);
    }
  }

  class ConvolverNode extends AudioNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'ConvolverNode');
      const o = dict(options, 'ConvolverOptions');
      makeNode(this, c, SHAPE(1, 1, 2, 'clamped-max', { maxCount: 2 }), {
        convolver: true,
        buffer: null,
        normalize: !o.disableNormalization,
      });
      if (o.buffer !== undefined && o.buffer !== null) this.buffer = o.buffer;
      channelOptions(this, o);
    }
    get buffer(): Any {
      return slotOf(this, 'convolver').buffer;
    }
    set buffer(v: Any) {
      const n = slotOf(this, 'convolver');
      if (v !== null && !isA(v, 'audioBuffer')) {
        throw typeError("The provided value is not of type 'AudioBuffer'.");
      }
      if (v !== null) {
        const b = apply(wmGet, slots, [v]);
        if (![1, 2, 4].includes(b.channels.length)) {
          throw domError(
            'A convolver’s buffer has 1, 2 or 4 channels.',
            'NotSupportedError',
          );
        }
        if (b.sampleRate !== n.context.sampleRate) {
          throw domError(
            'The buffer’s sample rate is not the context’s.',
            'NotSupportedError',
          );
        }
      }
      n.buffer = v;
    }
    get normalize(): boolean {
      return slotOf(this, 'convolver').normalize;
    }
    set normalize(v: Any) {
      slotOf(this, 'convolver').normalize = !!v;
    }
  }

  class AnalyserNode extends AudioNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'AnalyserNode');
      const o = dict(options, 'AnalyserOptions');
      makeNode(this, c, SHAPE(1, 1, 2, 'max'), {
        analyser: true,
        fftSize: 2048,
        minDecibels: -100,
        maxDecibels: -30,
        smoothingTimeConstant: 0.8,
      });
      if (o.fftSize !== undefined) this.fftSize = o.fftSize;
      if (o.maxDecibels !== undefined) this.maxDecibels = o.maxDecibels;
      if (o.minDecibels !== undefined) this.minDecibels = o.minDecibels;
      if (o.smoothingTimeConstant !== undefined) {
        this.smoothingTimeConstant = o.smoothingTimeConstant;
      }
      channelOptions(this, o);
    }
    get fftSize(): number {
      return slotOf(this, 'analyser').fftSize;
    }
    set fftSize(v: Any) {
      const n = slotOf(this, 'analyser');
      const size = +v >>> 0;
      if (size < 32 || size > 32768 || (size & (size - 1)) !== 0) {
        throw domError(
          'fftSize must be a power of two from 32 to 32768.',
          'IndexSizeError',
        );
      }
      n.fftSize = size;
    }
    get frequencyBinCount(): number {
      return slotOf(this, 'analyser').fftSize / 2;
    }
    get minDecibels(): number {
      return slotOf(this, 'analyser').minDecibels;
    }
    set minDecibels(v: Any) {
      const n = slotOf(this, 'analyser');
      const d = finite(v, 'double value');
      if (d >= n.maxDecibels) {
        throw domError(
          'minDecibels must be below maxDecibels.',
          'IndexSizeError',
        );
      }
      n.minDecibels = d;
    }
    get maxDecibels(): number {
      return slotOf(this, 'analyser').maxDecibels;
    }
    set maxDecibels(v: Any) {
      const n = slotOf(this, 'analyser');
      const d = finite(v, 'double value');
      if (d <= n.minDecibels) {
        throw domError(
          'maxDecibels must be above minDecibels.',
          'IndexSizeError',
        );
      }
      n.maxDecibels = d;
    }
    get smoothingTimeConstant(): number {
      return slotOf(this, 'analyser').smoothingTimeConstant;
    }
    set smoothingTimeConstant(v: Any) {
      const d = finite(v, 'double value');
      if (d < 0 || d > 1) {
        throw domError(
          'smoothingTimeConstant must be from 0 to 1.',
          'IndexSizeError',
        );
      }
      slotOf(this, 'analyser').smoothingTimeConstant = d;
    }
    // what it hears is silence: no frequency has any energy, and the wave
    // is flat at its middle
    getFloatFrequencyData(array: Any): void {
      slotOf(this, 'analyser');
      if (!(array instanceof F32))
        throw typeError('The array must be a Float32Array.');
      const n = min(array.length, this.frequencyBinCount);
      for (let i = 0; i < n; i++) array[i] = -1 / 0;
    }
    getByteFrequencyData(array: Any): void {
      slotOf(this, 'analyser');
      if (!(array instanceof U8))
        throw typeError('The array must be a Uint8Array.');
      const n = min(array.length, this.frequencyBinCount);
      for (let i = 0; i < n; i++) array[i] = 0;
    }
    getFloatTimeDomainData(array: Any): void {
      slotOf(this, 'analyser');
      if (!(array instanceof F32))
        throw typeError('The array must be a Float32Array.');
      const n = min(array.length, this.fftSize);
      for (let i = 0; i < n; i++) array[i] = 0;
    }
    getByteTimeDomainData(array: Any): void {
      slotOf(this, 'analyser');
      if (!(array instanceof U8))
        throw typeError('The array must be a Uint8Array.');
      const n = min(array.length, this.fftSize);
      for (let i = 0; i < n; i++) array[i] = 128;
    }
  }

  /** `createScriptProcessor`'s node, deprecated in Web Audio and kept by
   *  every browser: it is handed no audio here, so `audioprocess` never
   *  fires. */
  class ScriptProcessorNode extends AudioNode {
    get bufferSize(): number {
      return slotOf(this, 'script').bufferSize;
    }
  }
  handler(ScriptProcessorNode.prototype, 'audioprocess');

  class AudioDestinationNode extends AudioNode {
    get maxChannelCount(): number {
      slotOf(this, 'destination');
      return 2;
    }
  }

  class MediaStreamAudioDestinationNode extends AudioNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'MediaStreamAudioDestinationNode');
      if (!c.realtime) {
        throw domError(
          'A stream destination needs an AudioContext.',
          'NotSupportedError',
        );
      }
      const o = dict(options, 'AudioNodeOptions');
      const n = makeNode(this, c, SHAPE(1, 0, 2, 'explicit'), {
        streamDestination: true,
      });
      const source = call('mdSynth', c.sampleRate);
      n.source = typeof source === 'number' ? source : -1;
      const track = D.track(
        'audio',
        n.source,
        'MediaStreamAudioDestinationNode',
        false,
      );
      n.stream = new MediaStream([track]);
      c.destinations.add(n);
      channelOptions(this, o);
      render(n);
    }
    get stream(): Any {
      return slotOf(this, 'streamDestination').stream;
    }
  }

  class MediaStreamAudioSourceNode extends AudioNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'MediaStreamAudioSourceNode');
      const o = dict(options, 'MediaStreamAudioSourceOptions');
      if (!D.isStream(o.mediaStream)) {
        throw typeError(
          "Failed to construct 'MediaStreamAudioSourceNode': required member mediaStream is not a MediaStream.",
        );
      }
      if (!o.mediaStream.getAudioTracks().length) {
        throw domError('The stream has no audio track.', 'InvalidStateError');
      }
      makeNode(this, c, SHAPE(0, 1), {
        streamSource: true,
        stream: o.mediaStream,
      });
    }
    get mediaStream(): Any {
      return slotOf(this, 'streamSource').stream;
    }
  }

  class MediaElementAudioSourceNode extends AudioNode {
    constructor(context: Any, options: Any = undefined) {
      super(TOKEN);
      const c = contextOf(context, 'MediaElementAudioSourceNode');
      const o = dict(options, 'MediaElementAudioSourceOptions');
      if (!o.mediaElement || typeof o.mediaElement !== 'object') {
        throw typeError(
          "Failed to construct 'MediaElementAudioSourceNode': required member mediaElement is undefined.",
        );
      }
      makeNode(this, c, SHAPE(0, 1), {
        elementSource: true,
        element: o.mediaElement,
      });
    }
    get mediaElement(): Any {
      return slotOf(this, 'elementSource').element;
    }
  }

  // --- buffers and waves --------------------------------------------------------------

  class AudioBuffer {
    constructor(options: Any) {
      const o = dict(options, 'AudioBufferOptions');
      if (o.length === undefined || o.sampleRate === undefined) {
        throw typeError(
          "Failed to construct 'AudioBuffer': required member length or sampleRate is undefined.",
        );
      }
      const channels =
        o.numberOfChannels === undefined ? 1 : +o.numberOfChannels >>> 0;
      const length = +o.length >>> 0;
      const rate = finite(o.sampleRate, 'float value');
      if (channels < 1 || channels > 32) {
        throw domError(
          'numberOfChannels must be from 1 to 32.',
          'NotSupportedError',
        );
      }
      if (length < 1)
        throw domError('length must be at least 1.', 'NotSupportedError');
      if (rate < 3000 || rate > 768000) {
        throw domError(
          'sampleRate must be from 3000 to 768000.',
          'NotSupportedError',
        );
      }
      const data: Any[] = [];
      for (let i = 0; i < channels; i++) data.push(new F32(length));
      apply(wmSet, slots, [
        this,
        { audioBuffer: true, channels: data, length, sampleRate: rate },
      ]);
    }
    get sampleRate(): number {
      return slotOf(this, 'audioBuffer').sampleRate;
    }
    get length(): number {
      return slotOf(this, 'audioBuffer').length;
    }
    get duration(): number {
      const b = slotOf(this, 'audioBuffer');
      return b.length / b.sampleRate;
    }
    get numberOfChannels(): number {
      return slotOf(this, 'audioBuffer').channels.length;
    }
    getChannelData(channel: Any): Any {
      const b = slotOf(this, 'audioBuffer');
      const i = +channel >>> 0;
      if (i >= b.channels.length) {
        throw domError('The channel index is out of range.', 'IndexSizeError');
      }
      return b.channels[i];
    }
    copyFromChannel(
      destination: Any,
      channelNumber: Any,
      bufferOffset: Any = 0,
    ): void {
      const b = slotOf(this, 'audioBuffer');
      if (!(destination instanceof F32))
        throw typeError('The destination must be a Float32Array.');
      const i = +channelNumber >>> 0;
      if (i >= b.channels.length) {
        throw domError('The channel index is out of range.', 'IndexSizeError');
      }
      const from = +bufferOffset >>> 0;
      const src = b.channels[i];
      const n = max(0, min(destination.length, src.length - from));
      for (let k = 0; k < n; k++) destination[k] = src[from + k];
    }
    copyToChannel(
      source: Any,
      channelNumber: Any,
      bufferOffset: Any = 0,
    ): void {
      const b = slotOf(this, 'audioBuffer');
      if (!(source instanceof F32))
        throw typeError('The source must be a Float32Array.');
      const i = +channelNumber >>> 0;
      if (i >= b.channels.length) {
        throw domError('The channel index is out of range.', 'IndexSizeError');
      }
      const at = +bufferOffset >>> 0;
      const dst = b.channels[i];
      const n = max(0, min(source.length, dst.length - at));
      for (let k = 0; k < n; k++) dst[at + k] = source[k];
    }
  }

  class PeriodicWave {
    constructor(context: Any, options: Any = undefined) {
      contextOf(context, 'PeriodicWave');
      const o = dict(options, 'PeriodicWaveOptions');
      const read = (v: Any): number[] | null =>
        v === undefined
          ? null
          : [...v].map((x: Any) => finite(x, 'float value'));
      let real = read(o.real);
      let imag = read(o.imag);
      if (real && imag && real.length !== imag.length) {
        throw domError(
          'real and imag must be of one length.',
          'IndexSizeError',
        );
      }
      if ((real && real.length < 2) || (imag && imag.length < 2)) {
        throw domError(
          'A wave needs at least two coefficients.',
          'IndexSizeError',
        );
      }
      const n = real?.length ?? imag?.length ?? 2;
      real = real ?? new Array(n).fill(0);
      imag = imag ?? [0, 1, ...new Array(max(0, n - 2)).fill(0)].slice(0, n);
      apply(wmSet, slots, [
        this,
        { wave: true, real, imag, normalize: !o.disableNormalization },
      ]);
    }
  }

  class AudioListener {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegalConstructor();
    }
    get positionX(): Any {
      return slotOf(this, 'listener').positionX;
    }
    get positionY(): Any {
      return slotOf(this, 'listener').positionY;
    }
    get positionZ(): Any {
      return slotOf(this, 'listener').positionZ;
    }
    get forwardX(): Any {
      return slotOf(this, 'listener').forwardX;
    }
    get forwardY(): Any {
      return slotOf(this, 'listener').forwardY;
    }
    get forwardZ(): Any {
      return slotOf(this, 'listener').forwardZ;
    }
    get upX(): Any {
      return slotOf(this, 'listener').upX;
    }
    get upY(): Any {
      return slotOf(this, 'listener').upY;
    }
    get upZ(): Any {
      return slotOf(this, 'listener').upZ;
    }
    setPosition(x: Any, y: Any, z: Any): void {
      this.positionX.value = x;
      this.positionY.value = y;
      this.positionZ.value = z;
    }
    setOrientation(x: Any, y: Any, z: Any, xUp: Any, yUp: Any, zUp: Any): void {
      this.forwardX.value = x;
      this.forwardY.value = y;
      this.forwardZ.value = z;
      this.upX.value = xUp;
      this.upY.value = yUp;
      this.upZ.value = zUp;
    }
  }

  // --- what a destination's track renders ---------------------------------------------

  /** What reaches a node's input, through gains alone: each oscillator and
   *  constant source, with the gain the path multiplies it by. */
  const feeding = (c: Any, target: Any): Any[] => {
    const out: Any[] = [];
    const t = timeOf(c);
    const walk = (n: Any, gain: number, depth: number): void => {
      if (depth > 64) return;
      for (const from of n.inputs) {
        if (from.oscillator || from.constant) {
          if (from.start === null || from.ended) continue;
          out.push({ node: from, gain });
        } else if (from.gainNode) {
          walk(from, gain * valueAt(paramSlot(from.gain), t), depth + 1);
        }
        // anything else between is silence there
      }
    };
    walk(target, 1, 0);
    return out;
  };
  /** Tells the host what a stream destination renders now. */
  const render = (d: Any): void => {
    if (d.source < 0) return;
    const c = d.context;
    const t = timeOf(c);
    const voices = feeding(c, d).map(({ node, gain }) =>
      node.oscillator
        ? {
            kind: 'oscillator',
            type: node.type,
            frequency: valueAt(paramSlot(node.frequency), t),
            detune: valueAt(paramSlot(node.detune), t),
            real: node.wave?.real ?? null,
            imag: node.wave?.imag ?? null,
            gain,
            start: node.start,
            stop: node.stop,
          }
        : {
            kind: 'constant',
            offset: valueAt(paramSlot(node.offset), t),
            gain,
            start: node.start,
            stop: node.stop,
          },
    );
    const key = stringify({ running: c.state === 'running', voices });
    if (key === d.told) return;
    d.told = key;
    call(
      'mdSynthGraph',
      d.source,
      stringify({ running: c.state === 'running', time: t, voices }),
    );
  };
  const renderAll = (c: Any): void => {
    for (const d of c.destinations) render(d);
  };
  /** The graph or a value changed: what each destination renders, once
   *  this task is done. */
  const graphChanged = (c: Any): void => {
    if (!c || c.pending) return;
    c.pending = true;
    setTimer(() => {
      c.pending = false;
      renderAll(c);
    }, 0);
  };

  // --- contexts --------------------------------------------------------------------------

  class BaseAudioContext extends EventTarget {
    constructor(token: Any = undefined) {
      super();
      if (token !== TOKEN) throw illegalConstructor();
    }
    get destination(): Any {
      return slotOf(this, 'context').destination;
    }
    get sampleRate(): number {
      return slotOf(this, 'context').sampleRate;
    }
    get currentTime(): number {
      return timeOf(slotOf(this, 'context'));
    }
    get listener(): Any {
      return slotOf(this, 'context').listener;
    }
    get state(): string {
      return slotOf(this, 'context').state;
    }
    get renderQuantumSize(): number {
      slotOf(this, 'context');
      return 128;
    }
    createGain(): Any {
      return new GainNode(this);
    }
    createOscillator(): Any {
      return new OscillatorNode(this);
    }
    createConstantSource(): Any {
      return new ConstantSourceNode(this);
    }
    createBufferSource(): Any {
      return new AudioBufferSourceNode(this);
    }
    createBuffer(numberOfChannels: Any, length: Any, sampleRate: Any): Any {
      return new AudioBuffer({ numberOfChannels, length, sampleRate });
    }
    createDelay(maxDelayTime: Any = 1): Any {
      return new DelayNode(this, { maxDelayTime });
    }
    createBiquadFilter(): Any {
      return new BiquadFilterNode(this);
    }
    createIIRFilter(feedforward: Any, feedback: Any): Any {
      return new IIRFilterNode(this, { feedforward, feedback });
    }
    createWaveShaper(): Any {
      return new WaveShaperNode(this);
    }
    createDynamicsCompressor(): Any {
      return new DynamicsCompressorNode(this);
    }
    createStereoPanner(): Any {
      return new StereoPannerNode(this);
    }
    createPanner(): Any {
      return new PannerNode(this);
    }
    createChannelMerger(numberOfInputs: Any = 6): Any {
      return new ChannelMergerNode(this, { numberOfInputs });
    }
    createChannelSplitter(numberOfOutputs: Any = 6): Any {
      return new ChannelSplitterNode(this, { numberOfOutputs });
    }
    createConvolver(): Any {
      return new ConvolverNode(this);
    }
    createAnalyser(): Any {
      return new AnalyserNode(this);
    }
    createPeriodicWave(
      real: Any,
      imag: Any,
      constraints: Any = undefined,
    ): Any {
      const o = dict(constraints, 'PeriodicWaveConstraints');
      return new PeriodicWave(this, {
        real,
        imag,
        disableNormalization: !!o.disableNormalization,
      });
    }
    createScriptProcessor(
      bufferSize: Any = 0,
      inputs: Any = 2,
      outputs: Any = 2,
    ): Any {
      const c = slotOf(this, 'context');
      const size = +bufferSize >>> 0;
      if (
        size !== 0 &&
        ![256, 512, 1024, 2048, 4096, 8192, 16384].includes(size)
      ) {
        throw domError(
          'bufferSize must be a power of two from 256 to 16384, or 0.',
          'IndexSizeError',
        );
      }
      const ins = +inputs >>> 0;
      const outs = +outputs >>> 0;
      if ((ins === 0 && outs === 0) || ins > 32 || outs > 32) {
        throw domError(
          'The channel counts are out of range.',
          'IndexSizeError',
        );
      }
      const node = new ScriptProcessorNode(TOKEN);
      makeNode(
        node,
        c,
        SHAPE(1, 1, ins || 1, 'explicit', {
          fixedCount: true,
          fixedMode: true,
        }),
        {
          script: true,
          bufferSize: size || 1024,
        },
      );
      return node;
    }
    /** Decodes nothing yet: what it is handed is refused as a browser
     *  refuses what it cannot decode. */
    decodeAudioData(
      audioData: Any,
      successCallback: Any = undefined,
      errorCallback: Any = undefined,
    ): Promise<Any> {
      let c: Any;
      try {
        c = slotOf(this, 'context');
      } catch (error) {
        return P.reject(error);
      }
      if (!(audioData instanceof ArrayBuffer)) {
        return P.reject(
          typeError(
            "Failed to execute 'decodeAudioData': parameter 1 is not of type 'ArrayBuffer'.",
          ),
        );
      }
      return new P((resolve: Any, reject: Any) => {
        const decoded = decodeWav(audioData, c.sampleRate);
        setTimer(() => {
          const callback = decoded ? successCallback : errorCallback;
          const error =
            decoded ??
            domError('Unable to decode audio data.', 'EncodingError');
          if (typeof callback === 'function') {
            try {
              callback(error);
            } catch {
              // a callback's throw is the page's
            }
          }
          if (decoded) resolve(decoded);
          else reject(error);
        }, 0);
      });
    }
  }
  handler(BaseAudioContext.prototype, 'statechange');

  /**
   * A WAV file as an `AudioBuffer` at a context's rate, by straight-line
   * interpolation, and null for anything else: PCM of 8, 16, 24 or 32 bits,
   * or floats of 32. That is the one format with no decoder to bring, which
   * is the sound a page's interface makes: jspaint put a dialog over itself
   * for each it could not read. Everything else is the `EncodingError` a
   * browser gives what it cannot decode.
   */
  const decodeWav = (data: Any, rate: number): Any => {
    const view = new DataView(data);
    const tag = (at: number): string =>
      String.fromCharCode(
        view.getUint8(at),
        view.getUint8(at + 1),
        view.getUint8(at + 2),
        view.getUint8(at + 3),
      );
    if (view.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
      return null;
    }
    let format = 0;
    let channels = 0;
    let fileRate = 0;
    let bits = 0;
    let start = -1;
    let bytes = 0;
    for (let at = 12; at + 8 <= view.byteLength;) {
      const size = view.getUint32(at + 4, true);
      if (tag(at) === 'fmt ' && at + 24 <= view.byteLength) {
        format = view.getUint16(at + 8, true);
        channels = view.getUint16(at + 10, true);
        fileRate = view.getUint32(at + 12, true);
        bits = view.getUint16(at + 22, true);
        // WAVE_FORMAT_EXTENSIBLE: the format is the sub-format's first word
        if (format === 0xfffe && at + 34 <= view.byteLength) {
          format = view.getUint16(at + 32, true);
        }
      } else if (tag(at) === 'data') {
        start = at + 8;
        bytes = Math.min(size, view.byteLength - start);
        break;
      }
      at += 8 + size + (size & 1);
    }
    const width = bits >> 3;
    const known =
      (format === 1 && [1, 2, 3, 4].includes(width)) ||
      (format === 3 && width === 4);
    if (!known || start < 0 || !channels || !fileRate) return null;
    const frames = floor(bytes / (width * channels));
    if (frames < 1) return null;
    const sample = (at: number): number => {
      if (format === 3) return view.getFloat32(at, true);
      if (width === 1) return (view.getUint8(at) - 128) / 128;
      if (width === 2) return view.getInt16(at, true) / 32768;
      if (width === 4) return view.getInt32(at, true) / 2147483648;
      const low = view.getUint16(at, true);
      return ((view.getInt8(at + 2) << 16) | low) / 8388608;
    };
    const length = max(1, floor((frames * rate) / fileRate));
    const out = new AudioBuffer({
      length,
      numberOfChannels: channels,
      sampleRate: rate,
    });
    for (let channel = 0; channel < channels; channel += 1) {
      const samples = out.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        const place = (i * fileRate) / rate;
        const whole = floor(place);
        const next = whole + 1 < frames ? whole + 1 : whole;
        const a = sample(start + (whole * channels + channel) * width);
        const b = sample(start + (next * channels + channel) * width);
        samples[i] = a + (b - a) * (place - whole);
      }
    }
    return out;
  };

  const makeContext = (
    self: Any,
    sampleRate: number,
    realtime: boolean,
  ): Any => {
    const c: Any = {
      context: true,
      self,
      sampleRate,
      realtime,
      state: 'suspended',
      time: 0,
      since: now(),
      scheduled: new Set<Any>(),
      destinations: new Set<Any>(),
      pending: false,
    };
    apply(wmSet, slots, [self, c]);
    const destination = new AudioDestinationNode(TOKEN);
    makeNode(destination, c, SHAPE(1, 0, 2, 'explicit', { maxCount: 2 }), {
      destination: true,
    });
    c.destination = destination;
    const listener = new AudioListener(TOKEN);
    const l: Any = { listener: true };
    apply(wmSet, slots, [listener, l]);
    const owner = { context: c };
    for (const [k, v] of [
      ['positionX', 0],
      ['positionY', 0],
      ['positionZ', 0],
      ['forwardX', 0],
      ['forwardY', 0],
      ['forwardZ', -1],
      ['upX', 0],
      ['upY', 1],
      ['upZ', 0],
    ] as [string, number][]) {
      l[k] = param(owner, v);
    }
    c.listener = listener;
    return c;
  };

  class AudioContext extends BaseAudioContext {
    constructor(options: Any = undefined) {
      super(TOKEN);
      const o = dict(options, 'AudioContextOptions');
      if (
        o.latencyHint !== undefined &&
        typeof o.latencyHint !== 'number' &&
        !['interactive', 'balanced', 'playback'].includes(String(o.latencyHint))
      ) {
        throw typeError(
          `The provided value '${String(o.latencyHint)}' is not a valid enum value of type AudioContextLatencyCategory.`,
        );
      }
      const rate =
        o.sampleRate === undefined
          ? 48000
          : finite(o.sampleRate, 'float value');
      if (rate < 3000 || rate > 768000) {
        throw domError(
          'sampleRate must be from 3000 to 768000.',
          'NotSupportedError',
        );
      }
      const c = makeContext(this, rate, true);
      c.baseLatency = 128 / rate;
      // allowed to start, as a context is where a page may play: it runs
      // once the task that made it is done, and says so (Web Audio 1.2.1)
      setTimer(() => {
        if (c.state === 'suspended' && !c.suspendedByPage)
          setState(c, 'running');
      }, 0);
    }
    get baseLatency(): number {
      return slotOf(this, 'context').baseLatency;
    }
    /** How far behind the output is: nothing, as there is no output. */
    get outputLatency(): number {
      slotOf(this, 'context');
      return 0;
    }
    getOutputTimestamp(): Any {
      const c = slotOf(this, 'context');
      return { contextTime: timeOf(c), performanceTime: now() };
    }
    resume(): Promise<void> {
      let c: Any;
      try {
        c = slotOf(this, 'context');
      } catch (error) {
        return P.reject(error);
      }
      if (c.state === 'closed') {
        return P.reject(
          domError('The context is closed.', 'InvalidStateError'),
        );
      }
      c.suspendedByPage = false;
      return new P((resolve: Any) =>
        setTimer(() => {
          if (c.state === 'suspended') setState(c, 'running');
          resolve(undefined);
        }, 0),
      );
    }
    suspend(): Promise<void> {
      let c: Any;
      try {
        c = slotOf(this, 'context');
      } catch (error) {
        return P.reject(error);
      }
      if (c.state === 'closed') {
        return P.reject(
          domError('The context is closed.', 'InvalidStateError'),
        );
      }
      c.suspendedByPage = true;
      return new P((resolve: Any) =>
        setTimer(() => {
          if (c.state === 'running') setState(c, 'suspended');
          resolve(undefined);
        }, 0),
      );
    }
    close(): Promise<void> {
      let c: Any;
      try {
        c = slotOf(this, 'context');
      } catch (error) {
        return P.reject(error);
      }
      if (c.state === 'closed') {
        return P.reject(
          domError('The context is closed.', 'InvalidStateError'),
        );
      }
      return new P((resolve: Any) =>
        setTimer(() => {
          setState(c, 'closed');
          resolve(undefined);
        }, 0),
      );
    }
    createMediaStreamDestination(): Any {
      return new MediaStreamAudioDestinationNode(this);
    }
    createMediaStreamSource(mediaStream: Any): Any {
      return new MediaStreamAudioSourceNode(this, { mediaStream });
    }
    createMediaElementSource(mediaElement: Any): Any {
      return new MediaElementAudioSourceNode(this, { mediaElement });
    }
  }

  idl({
    BaseAudioContext,
    AudioContext,
    AudioNode,
    AudioParam,
    AudioScheduledSourceNode,
    OscillatorNode,
    ConstantSourceNode,
    AudioBufferSourceNode,
    GainNode,
    DelayNode,
    BiquadFilterNode,
    IIRFilterNode,
    WaveShaperNode,
    DynamicsCompressorNode,
    StereoPannerNode,
    PannerNode,
    ChannelMergerNode,
    ChannelSplitterNode,
    ConvolverNode,
    AnalyserNode,
    ScriptProcessorNode,
    AudioDestinationNode,
    MediaStreamAudioDestinationNode,
    MediaStreamAudioSourceNode,
    MediaElementAudioSourceNode,
    AudioBuffer,
    PeriodicWave,
    AudioListener,
  });

  return {
    BaseAudioContext,
    AudioContext,
    AudioNode,
    AudioParam,
    AudioScheduledSourceNode,
    OscillatorNode,
    ConstantSourceNode,
    AudioBufferSourceNode,
    GainNode,
    DelayNode,
    BiquadFilterNode,
    IIRFilterNode,
    WaveShaperNode,
    DynamicsCompressorNode,
    StereoPannerNode,
    PannerNode,
    ChannelMergerNode,
    ChannelSplitterNode,
    ConvolverNode,
    AnalyserNode,
    ScriptProcessorNode,
    AudioDestinationNode,
    MediaStreamAudioDestinationNode,
    MediaStreamAudioSourceNode,
    MediaElementAudioSourceNode,
    AudioBuffer,
    PeriodicWave,
    AudioListener,
  };
}
