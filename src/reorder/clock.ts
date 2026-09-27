// The drop flight's clock — the time it reads and the timer that steps it —
// in a module of its own, so that a test can hold it.
//
// The flight home is wall-clock time on purpose: `dropAnimation={180}` is a
// hundred and eighty milliseconds however many frames the machine manages.
// That is also what makes it hard to look at. A runner slow enough to spend
// the whole flight inside the `await` that released the item finds it
// already landed, which is how "a drag that landed nowhere flies back"
// failed on CI. `test/held-clock.ts` stands in for this object and nothing
// else, so the drag, and the layout tick the flight starts from, stay real.
//
// Exported from this module and not from `./index.ts`: everything there is
// the package's `./reorder` subpath, and this is for the tests.
import { cancelLater, later } from '../internal/timers.js';
import type { DelayTick } from '../internal/timers.js';

export const flightClock = {
  now(): number {
    return Date.now();
  },
  arm(step: () => void, ms: number): DelayTick {
    return later(step, ms);
  },
  disarm(handle: DelayTick): void {
    cancelLater(handle);
  },
};
