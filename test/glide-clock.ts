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
// else, so the settle window and the harness's own timers run for real.
//
// Not a `.test.ts` file, so `tsx --test test/*.test.ts` does not run it, but
// `tsconfig.json` does typecheck it.
import type { TestContext } from 'node:test';
import { act } from 'react-x11/test';

import { glideClock } from '../src/maps/controller.js';

/** A 60Hz frame — what the controller's own timer waits. */
const FRAME_MS = 16;

export interface HeldGlide {
  /** Whether a step is waiting for its frame. */
  readonly pending: boolean;
  /** One frame: the clock moves on by a frame and the waiting step is
   *  taken. False when there was none. */
  frame(): Promise<boolean>;
  /** Frames until the glide stops asking for them, and how many it took. */
  finish(): Promise<number>;
}

/** Hold the glide for the rest of `t` — `t.mock` puts the real clock back
 *  when the test ends. */
export function holdGlide(t: TestContext): HeldGlide {
  let time = 0;
  let waiting: (() => void) | null = null;
  t.mock.method(glideClock, 'now', () => time);
  t.mock.method(glideClock, 'arm', (tick: () => void) => {
    waiting = tick;
    return tick;
  });
  t.mock.method(glideClock, 'disarm', () => {
    waiting = null;
  });
  const held: HeldGlide = {
    get pending() {
      return waiting !== null;
    },
    async frame() {
      const tick = waiting;
      if (!tick) return false;
      waiting = null;
      time += FRAME_MS;
      await act(async () => tick());
      return true;
    },
    async finish() {
      let frames = 0;
      while (await held.frame()) {
        // A glide is all but over in three time constants; a hundred frames
        // is one that never arrives.
        if (++frames > 100) throw new Error('the glide never arrived');
      }
      return frames;
    },
  };
  return held;
}
