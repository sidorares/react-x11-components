// Resource Timing 2 as a page's scripts see it: `PerformanceEntry`,
// `PerformanceResourceTiming`, `PerformanceServerTiming` and the
// `Performance` interface their `performance` is, with the resource timing
// buffer — its size limit, its secondary buffer and the
// `resourcetimingbufferfull` event that empties it (Resource Timing 2, 4.4,
// 4.5).
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing.
//
// What an entry says is the host's to work out (`../resource-timing.ts`):
// it arrives as the record of its attributes, worked out where the response
// was, under the rules of what another origin lets a page see of it.

/** What `installDom` hands this. */
export interface ResourceTimingDeps {
  EventTarget: unknown;
  Event: unknown;
  /** Sets a target's `on<type>` handler (HTML 8.1.8.1). */
  setHandler(target: unknown, type: string, value: unknown): void;
  getHandler(target: unknown, type: string): unknown;
  /** Dispatches an event the user agent fires. */
  fire(target: unknown, event: unknown): void;
  /** A task the page cannot see or cancel. */
  later(fn: () => void, ms: number): void;
  /** Hands an entry to the observers that watch its type (Performance
   *  Timeline 2, "queue a PerformanceEntry"). */
  queue(entry: unknown): void;
  /** The realm's high resolution time. */
  now(): number;
  /** A value structured-serialized and deserialized in this realm, or the
   *  `DataCloneError` it throws. */
  clone(value: unknown): unknown;
  /** Whether the global is a `Window`, where the names of
   *  `PerformanceTiming`'s attributes are its and not a mark's. */
  inWindow(): boolean;
  /** `performance.timing[name]`, a time since the epoch or 0. */
  timing(name: string): number;
  /** The performance entry buffer the marks and measures are kept in,
   *  which `mark` and `measure` add to and the clears take from. */
  entries(): unknown[];
  /** A `DOMException` of this realm. */
  error(message: string, name: string): unknown;
}

export function installResourceTiming(D: ResourceTimingDeps): {
  interfaces: Record<string, unknown>;
  internals: {
    /** A `performance` object, with no members of its own yet. */
    makePerformance(): unknown;
    /** The resource timing buffer, in the order entries came. */
    buffer(): unknown[];
    /** An entry the host made of a fetch the document made. */
    add(record: Record<string, unknown>): void;
  };
} {
  'use strict';
  type Any = any;
  const KEY = Symbol('made');
  const illegal = (): never => {
    throw new TypeError('Illegal constructor');
  };
  /** Each entry's attributes, kept where no page reaches them. */
  const slots = new WeakMap<object, Record<string, Any>>();
  const slotOf = (self: Any, name: string): Record<string, Any> => {
    const slot = slots.get(self);
    if (!slot) {
      throw new TypeError(
        `Failed to read the '${name}' property: Illegal invocation`,
      );
    }
    return slot;
  };
  const reader = (proto: object, names: string[]): void => {
    for (const name of names) {
      Object.defineProperty(proto, name, {
        get(this: Any) {
          return slotOf(this, name)[name];
        },
        enumerable: true,
        configurable: true,
      });
    }
  };
  const tag = (proto: object, name: string): void => {
    Object.defineProperty(proto, Symbol.toStringTag, {
      value: name,
      configurable: true,
    });
  };

  /** Performance Timeline 2's base of every entry. */
  class PerformanceEntry {
    constructor(token?: Any) {
      if (token !== KEY) illegal();
    }
    toJSON(this: Any): Any {
      slotOf(this, 'toJSON');
      return {
        name: this.name,
        entryType: this.entryType,
        startTime: this.startTime,
        duration: this.duration,
      };
    }
  }
  reader(PerformanceEntry.prototype, [
    'name',
    'entryType',
    'startTime',
    'duration',
  ]);
  tag(PerformanceEntry.prototype, 'PerformanceEntry');

  const RESOURCE = [
    'initiatorType',
    'deliveryType',
    'nextHopProtocol',
    'workerStart',
    'redirectStart',
    'redirectEnd',
    'fetchStart',
    'domainLookupStart',
    'domainLookupEnd',
    'connectStart',
    'connectEnd',
    'secureConnectionStart',
    'requestStart',
    'finalResponseHeadersStart',
    'firstInterimResponseStart',
    'responseStart',
    'responseEnd',
    'workerRouterEvaluationStart',
    'workerCacheLookupStart',
    'workerMatchedRouterSource',
    'workerFinalRouterSource',
    'transferSize',
    'encodedBodySize',
    'decodedBodySize',
    'responseStatus',
    'renderBlockingStatus',
    'contentType',
    'contentEncoding',
  ];

  class PerformanceResourceTiming extends PerformanceEntry {
    constructor(token?: Any) {
      super(token);
    }
    get serverTiming(): Any {
      return slotOf(this, 'serverTiming').serverTiming;
    }
    override toJSON(this: Any): Any {
      const json = super.toJSON();
      for (const name of RESOURCE) json[name] = this[name];
      return json;
    }
  }
  reader(PerformanceResourceTiming.prototype, RESOURCE);
  Object.defineProperty(PerformanceResourceTiming.prototype, 'serverTiming', {
    enumerable: true,
  });
  tag(PerformanceResourceTiming.prototype, 'PerformanceResourceTiming');

  /** Server Timing's one metric. */
  class PerformanceServerTiming {
    constructor(token?: Any) {
      if (token !== KEY) illegal();
    }
    toJSON(this: Any): Any {
      return {
        name: this.name,
        duration: this.duration,
        description: this.description,
      };
    }
  }
  reader(PerformanceServerTiming.prototype, [
    'name',
    'duration',
    'description',
  ]);
  tag(PerformanceServerTiming.prototype, 'PerformanceServerTiming');

  // --- the resource timing buffer (Resource Timing 2, 4.4) -------------------

  const primary: Any[] = [];
  const secondary: Any[] = [];
  let limit = 250;
  let fullPending = false;
  let performanceObject: Any = null;

  const canAdd = (): boolean => primary.length < limit;
  const copySecondary = (): void => {
    while (secondary.length && canAdd()) primary.push(secondary.shift());
  };
  /** "fire a buffer full event". */
  const fireFull = (): void => {
    while (secondary.length) {
      const before = secondary.length;
      if (!canAdd() && performanceObject) {
        const Ev = D.Event as Any;
        D.fire(performanceObject, new Ev('resourcetimingbufferfull'));
      }
      copySecondary();
      if (before <= secondary.length) {
        secondary.length = 0;
        break;
      }
    }
    fullPending = false;
  };
  /** "add a PerformanceResourceTiming entry". */
  const addToBuffer = (entry: Any): void => {
    if (canAdd() && !fullPending) {
      primary.push(entry);
      return;
    }
    if (!fullPending) {
      fullPending = true;
      D.later(fireFull, 0);
    }
    secondary.push(entry);
  };

  // User Timing 3: `PerformanceMark`, `PerformanceMeasure`, and the
  // `Performance` operations that make and clear them.
  /** `PerformanceTiming`'s read-only attributes, which in a window are no
   *  mark's names (User Timing 3, 3.1.1 and 3.1.3). */
  const TIMING = new Set([
    'navigationStart',
    'unloadEventStart',
    'unloadEventEnd',
    'redirectStart',
    'redirectEnd',
    'fetchStart',
    'domainLookupStart',
    'domainLookupEnd',
    'connectStart',
    'connectEnd',
    'secureConnectionStart',
    'requestStart',
    'responseStart',
    'responseEnd',
    'domLoading',
    'domInteractive',
    'domContentLoadedEventStart',
    'domContentLoadedEventEnd',
    'domComplete',
    'loadEventStart',
    'loadEventEnd',
  ]);
  const required = (call: string, count: number, needed: number): void => {
    if (count < needed) {
      throw new TypeError(
        `Failed to execute '${call}': ${needed} argument${needed > 1 ? 's' : ''} required, but only ${count} present.`,
      );
    }
  };
  /** WebIDL's conversion to a dictionary: an object, or nothing. */
  const dictionary = (value: Any, call: string): Any => {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' && typeof value !== 'function') {
      throw new TypeError(
        `Failed to execute '${call}': The provided value is not of type 'Performance${call === 'mark' || call === 'PerformanceMark' ? 'Mark' : 'Measure'}Options'.`,
      );
    }
    return value;
  };
  /** WebIDL's `DOMHighResTimeStamp`, a `double`: a finite number. */
  const timeStamp = (value: Any): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new TypeError('The provided double value is non-finite.');
    }
    return n;
  };
  /** User Timing 3, 3.1.1, "create a PerformanceMark": its slot. */
  const markSlot = (name: Any, options: Any): Record<string, Any> => {
    const markName = String(name);
    if (D.inWindow() && TIMING.has(markName)) {
      throw D.error(
        `Failed to execute 'mark' on 'Performance': '${markName}' is part of the PerformanceTiming interface, and cannot be used as a mark name.`,
        'SyntaxError',
      );
    }
    const dict = dictionary(options, 'mark');
    // a dictionary's members are read in order: detail, startTime
    const detail = dict.detail;
    const given = dict.startTime;
    let startTime: number;
    if (given !== undefined) {
      startTime = timeStamp(given);
      if (startTime < 0) {
        throw new TypeError(
          `Failed to execute 'mark' on 'Performance': '${markName}' cannot have a negative start time.`,
        );
      }
    } else {
      startTime = D.now();
    }
    return {
      name: markName,
      entryType: 'mark',
      startTime,
      duration: 0,
      detail: detail === undefined || detail === null ? null : D.clone(detail),
    };
  };
  class PerformanceMark extends PerformanceEntry {
    constructor(markName?: Any, markOptions?: Any) {
      super(KEY);
      if (markName === KEY) return;
      required("'constructor' on 'PerformanceMark'", arguments.length, 1);
      slots.set(this, markSlot(markName, markOptions));
    }
    get detail(): Any {
      return slotOf(this, 'detail').detail;
    }
  }
  Object.defineProperty(PerformanceMark.prototype, 'detail', {
    enumerable: true,
  });
  tag(PerformanceMark.prototype, 'PerformanceMark');
  Object.defineProperty(PerformanceMark, 'length', { value: 1 });
  class PerformanceMeasure extends PerformanceEntry {
    constructor(token?: Any) {
      super(token);
    }
    get detail(): Any {
      return slotOf(this, 'detail').detail;
    }
  }
  Object.defineProperty(PerformanceMeasure.prototype, 'detail', {
    enumerable: true,
  });
  tag(PerformanceMeasure.prototype, 'PerformanceMeasure');
  Object.defineProperty(PerformanceMeasure, 'length', { value: 0 });

  /** User Timing 3, 3.1.3, "convert a mark to a timestamp". */
  const markTime = (mark: Any): number => {
    if (typeof mark === 'number') {
      if (mark < 0) {
        throw new TypeError(
          "Failed to execute 'measure' on 'Performance': a timestamp cannot be negative.",
        );
      }
      return mark;
    }
    const name = String(mark);
    if (TIMING.has(name)) {
      if (!D.inWindow()) {
        throw new TypeError(
          `Failed to execute 'measure' on 'Performance': '${name}' is not a mark of this global.`,
        );
      }
      const value = D.timing(name);
      if (value === 0) {
        throw D.error(
          `Failed to execute 'measure' on 'Performance': '${name}' is empty: either the event hasn't happened yet, or it would provide cross-origin timing information.`,
          'InvalidAccessError',
        );
      }
      return value - D.timing('navigationStart');
    }
    const list = D.entries() as Any[];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const e = list[i];
      if (e instanceof PerformanceMark && (e as Any).name === name) {
        return (e as Any).startTime;
      }
    }
    throw D.error(
      `Failed to execute 'measure' on 'Performance': The mark '${name}' does not exist.`,
      'SyntaxError',
    );
  };
  /** A member of a `PerformanceMeasureOptions`: `(DOMString or
   *  DOMHighResTimeStamp)`. */
  const startOrEnd = (value: Any): Any =>
    typeof value === 'number' ? timeStamp(value) : String(value);
  const clearOf = (type: string, name: Any): void => {
    const list = D.entries() as Any[];
    const only = name === undefined ? null : String(name);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const e = list[i];
      if (e.entryType === type && (only === null || e.name === only)) {
        list.splice(i, 1);
      }
    }
  };
  const add = (entry: Any): Any => {
    (D.entries() as Any[]).push(entry);
    D.queue(entry);
    return entry;
  };

  const ET = D.EventTarget as Any;
  /** HTML's `Performance`, whose `performance` object is the one instance:
   *  what Resource Timing adds to it is here, the rest the facade's own. */
  class Performance extends ET {
    constructor(token?: Any) {
      if (token !== KEY) illegal();
      super();
    }
    clearResourceTimings(): void {
      primary.length = 0;
    }
    setResourceTimingBufferSize(maxSize: Any): void {
      if (arguments.length < 1) {
        throw new TypeError(
          "Failed to execute 'setResourceTimingBufferSize' on 'Performance': 1 argument required, but only 0 present.",
        );
      }
      // `unsigned long`'s conversion
      const n = Number(maxSize);
      limit = Number.isFinite(n) ? Math.trunc(n) >>> 0 : 0;
      if (canAdd()) copySecondary();
    }
    mark(markName?: Any, markOptions?: Any): Any {
      required("'mark' on 'Performance'", arguments.length, 1);
      const entry = new PerformanceMark(KEY);
      slots.set(entry, markSlot(markName, markOptions));
      return add(entry);
    }
    clearMarks(markName?: Any): void {
      clearOf('mark', markName);
    }
    measure(measureName?: Any, startOrOptions?: Any, endMark?: Any): Any {
      required("'measure' on 'Performance'", arguments.length, 1);
      const name = String(measureName);
      // `(DOMString or PerformanceMeasureOptions)`, a dictionary where
      // it is nothing or an object
      const isOptions =
        startOrOptions === undefined ||
        startOrOptions === null ||
        typeof startOrOptions === 'object' ||
        typeof startOrOptions === 'function';
      let options: Any = null;
      let startMark: Any;
      if (isOptions) {
        const dict = dictionary(startOrOptions, 'measure');
        // in order: detail, duration, end, start
        const detail = dict.detail;
        const duration = dict.duration;
        const end = dict.end;
        const start = dict.start;
        options = {
          detail,
          duration: duration === undefined ? undefined : timeStamp(duration),
          end: end === undefined ? undefined : startOrEnd(end),
          start: start === undefined ? undefined : startOrEnd(start),
        };
      } else {
        startMark = String(startOrOptions);
      }
      const end = endMark === undefined ? undefined : String(endMark);
      if (
        options &&
        (options.start !== undefined ||
          options.end !== undefined ||
          options.duration !== undefined ||
          options.detail !== undefined)
      ) {
        if (end !== undefined) {
          throw new TypeError(
            "Failed to execute 'measure' on 'Performance': If a non-empty PerformanceMeasureOptions object was passed, |end_mark| must not be passed.",
          );
        }
        if (options.start === undefined && options.end === undefined) {
          throw new TypeError(
            "Failed to execute 'measure' on 'Performance': If a non-empty PerformanceMeasureOptions object was passed, at least one of its 'start' or 'end' properties must be present.",
          );
        }
        if (
          options.start !== undefined &&
          options.duration !== undefined &&
          options.end !== undefined
        ) {
          throw new TypeError(
            "Failed to execute 'measure' on 'Performance': If a non-empty PerformanceMeasureOptions object was passed, it must not have all of its 'start', 'duration', and 'end' properties defined",
          );
        }
      }
      let endTime: number;
      if (end !== undefined) endTime = markTime(end);
      else if (options?.end !== undefined) endTime = markTime(options.end);
      else if (options?.start !== undefined && options.duration !== undefined) {
        endTime = markTime(options.start) + options.duration;
      } else endTime = D.now();
      let startTime: number;
      if (options?.start !== undefined) startTime = markTime(options.start);
      else if (options?.duration !== undefined && options.end !== undefined) {
        startTime = endTime - options.duration;
      } else if (startMark !== undefined) startTime = markTime(startMark);
      else startTime = 0;
      const detail = options?.detail;
      const entry = new PerformanceMeasure(KEY);
      slots.set(entry, {
        name,
        entryType: 'measure',
        startTime,
        duration: endTime - startTime,
        detail:
          detail === undefined || detail === null ? null : D.clone(detail),
      });
      return add(entry);
    }
    clearMeasures(measureName?: Any): void {
      clearOf('measure', measureName);
    }
    get onresourcetimingbufferfull(): Any {
      return D.getHandler(this, 'resourcetimingbufferfull');
    }
    set onresourcetimingbufferfull(value: Any) {
      D.setHandler(this, 'resourcetimingbufferfull', value);
    }
  }
  tag(Performance.prototype, 'Performance');
  // an IDL operation is enumerable, where a class's method is not
  for (const name of [
    'mark',
    'clearMarks',
    'measure',
    'clearMeasures',
    'clearResourceTimings',
    'setResourceTimingBufferSize',
  ]) {
    Object.defineProperty(Performance.prototype, name, { enumerable: true });
  }

  return {
    interfaces: {
      Performance,
      PerformanceEntry,
      PerformanceMark,
      PerformanceMeasure,
      PerformanceResourceTiming,
      PerformanceServerTiming,
    },
    internals: {
      makePerformance() {
        performanceObject = new Performance(KEY);
        return performanceObject;
      },
      buffer: () => primary,
      add(record) {
        const entry = new PerformanceResourceTiming(KEY);
        const metrics = Object.freeze(
          ((record.serverTiming as Any[]) ?? []).map((m: Any) => {
            const one = new PerformanceServerTiming(KEY);
            slots.set(one, {
              name: String(m.name),
              duration: Number(m.duration) || 0,
              description: String(m.description ?? ''),
            });
            return one;
          }),
        );
        slots.set(entry, {
          workerRouterEvaluationStart: 0,
          workerCacheLookupStart: 0,
          workerMatchedRouterSource: '',
          workerFinalRouterSource: '',
          ...record,
          entryType: 'resource',
          serverTiming: metrics,
        });
        addToBuffer(entry);
        D.queue(entry);
      },
    },
  };
}
