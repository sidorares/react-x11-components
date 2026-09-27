// A wheel's glide on a clock that moves only when the test says so.
//
// The glide is wall-clock time: each step is exponential in the real gap
// since the one before, and a 16 ms timer takes them. A runner slow enough
// to spend its whole length — about a hundred and forty milliseconds —
// inside one `await userEvent.wheel(...)` finds it already over, which is
// how "the notch is not applied in one" flaked on CI with the camera at the
// notch's full 12.375. Held here, the notch's own step is all that happens
// under the event, and every step after it is a `frame()`.
//
// The wheel itself still goes through the server: this stands in for the
// controller's clock (`glideClock` in ../src/maps/controller.ts) and nothing
// else, so the settle window and the harness's own timers run for real. The
// holding is `./held-clock.ts`, which the reorder drop's flight shares.
//
// Not a `.test.ts` file, so `tsx --test test/*.test.ts` does not run it, but
// `tsconfig.json` does typecheck it.
import type { TestContext } from 'node:test';

import { glideClock } from '../src/maps/controller.js';
import { holdClock } from './held-clock.js';
import type { HeldClock } from './held-clock.js';

/** Hold the glide for the rest of `t` — `t.mock` puts the real clock back
 *  when the test ends. */
export function holdGlide(t: TestContext): HeldClock {
  return holdClock(t, glideClock);
}
