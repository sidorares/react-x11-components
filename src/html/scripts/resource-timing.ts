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
    get onresourcetimingbufferfull(): Any {
      return D.getHandler(this, 'resourcetimingbufferfull');
    }
    set onresourcetimingbufferfull(value: Any) {
      D.setHandler(this, 'resourcetimingbufferfull', value);
    }
  }
  tag(Performance.prototype, 'Performance');

  return {
    interfaces: {
      Performance,
      PerformanceEntry,
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
