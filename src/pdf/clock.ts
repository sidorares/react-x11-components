// The rest a zoom waits out before it asks for tiles at its own scale, in a
// module of its own so that a test can hold it.
//
// It is wall-clock time on purpose: a zoom rests when the wheel has stopped,
// however many frames the machine managed. That is also what makes it hard to
// look at, since a runner slow enough to spend the rest inside the `await` that
// zoomed finds the tiles already asked for. `test/held-clock.ts` stands in for
// this object and nothing else.
//
// Exported from this module and not from `./index.ts`: everything there is the
// package's `./pdf` subpath, and this is for the tests.
import { cancelLater, later } from '../internal/timers.js';
import type { DelayTick } from '../internal/timers.js';

export const restClock = {
  arm(step: () => void, ms: number): DelayTick {
    return later(step, ms);
  },
  disarm(handle: DelayTick): void {
    cancelLater(handle);
  },
};
