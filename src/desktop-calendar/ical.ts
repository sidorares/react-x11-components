// The slice of `ical.js` this package uses, and the loader that finds it.
//
// **`ical.js` is an `optionalDependency`, and these types are deliberately
// ours rather than the package's.** `import type … from 'ical.js'` would put
// the module in the type graph, and then an app that did not install it could
// not type-check against this package at all — which is the opposite of what
// "optional" means. So the surface is written out structurally, and the value
// arrives through a dynamic `import()` that is allowed to fail.
//
// react-x11 makes the same call with `dbus-native`, for the same reason.

/** An `ICAL.Time`. */
export interface IcalTime {
  toJSDate(): Date;
  clone(): IcalTime;
  addDuration(duration: unknown): void;
  /** True for a date without a time — an all-day event's start. */
  isDate: boolean;
}

export interface IcalProperty {
  getParameter(name: string): string | undefined;
}

export interface IcalComponent {
  name: string;
  getFirstSubcomponent(name: string): IcalComponent | null;
  getAllSubcomponents(name: string): IcalComponent[];
  getFirstProperty(name: string): IcalProperty | null;
}

export interface IcalRecurExpansion {
  next(): IcalTime | null;
}

export interface IcalEvent {
  uid: string;
  summary: string;
  location: string;
  description: string;
  startDate: IcalTime;
  endDate: IcalTime;
  duration: unknown;
  isRecurring(): boolean;
  isRecurrenceException(): boolean;
  iterator(): IcalRecurExpansion;
  getOccurrenceDetails(time: IcalTime): {
    startDate: IcalTime;
    endDate: IcalTime;
  };
}

export interface IcalTimezone {
  tzid: string;
}

/** What `import('ical.js')` gives back, as far as this package is concerned. */
export interface IcalModule {
  parse(input: string): unknown;
  Component: new (jcal: unknown) => IcalComponent;
  Event: new (component: IcalComponent) => IcalEvent;
  Timezone: new (component: IcalComponent) => IcalTimezone;
  TimezoneService: {
    has(tzid: string): boolean;
    register(tzid: string, zone: IcalTimezone): void;
  };
}

/** Thrown when the calendar is asked for events and `ical.js` is not there. */
export class IcalUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      "@react-x11/components: reading desktop calendar events needs 'ical.js', " +
        'which is an optional dependency and is not installed. ' +
        'Run `npm install ical.js`. Listing calendars does not need it.',
      { cause },
    );
    this.name = 'IcalUnavailableError';
  }
}

let cached: Promise<IcalModule> | null = null;

/**
 * Load `ical.js`, once.
 *
 * Deliberately **not** cached as a rejection: a failed load is almost always
 * "not installed", but retrying costs nothing and a cached rejection would
 * outlive an app that installed it and re-rendered.
 */
export async function loadIcal(): Promise<IcalModule> {
  if (cached) return cached;
  const attempt = (async (): Promise<IcalModule> => {
    try {
      // The specifier is built at run time so a bundler treats this as a
      // genuinely optional import and does not fail the build resolving a
      // package the app may well not have.
      const name = 'ical.js';
      const mod = (await import(/* @vite-ignore */ name)) as {
        default?: IcalModule;
      } & IcalModule;
      // ical.js is CJS-with-a-default under some resolutions and a namespace
      // under others; `parse` is on whichever one is real.
      const resolved = typeof mod.parse === 'function' ? mod : mod.default;
      if (!resolved || typeof resolved.parse !== 'function') {
        throw new TypeError('ical.js did not export what was expected');
      }
      return resolved;
    } catch (err) {
      throw new IcalUnavailableError(err);
    }
  })();
  // Only a successful load is remembered.
  cached = attempt.catch((err: unknown) => {
    cached = null;
    throw err;
  });
  return cached;
}
