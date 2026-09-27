// An animation's clock, held: its time moves only when the test says so.
//
// Two animations here run on the wall clock on purpose — the maps wheel's
// glide (`glideClock` in ../src/maps/controller.ts) and a reorder drop's
// flight home (`flightClock` in ../src/reorder/clock.ts). Each reads the
// time when it starts and again at every step, and a timer takes the steps.
// A runner slow enough to spend the whole animation inside one `await` finds
// it already over, and both have failed on CI that way. Held, the step taken
// under the event is all that happens there, and every step after it is a
// `frame()` the test takes.
//
// It stands in for the clock and nothing else: the event still goes through
// the in-process X server, and the harness's own timers and the component's
// other ones — a settle window, a layout tick — run for real.
//
// Not a `.test.ts` file, so `tsx --test test/*.test.ts` does not run it, but
// `tsconfig.json` does typecheck it.
import type { TestContext } from 'node:test';
import { act } from 'react-x11/test';

/** The shape both clocks share: the time, and a timer for the next step. */
export interface AnimationClock {
  now(): number;
  arm(step: () => void, ms: number): unknown;
  disarm(handle: unknown): void;
}

/** A 60Hz frame — what both animations' own timers wait. */
const FRAME_MS = 16;

export interface HeldClock {
  /** Whether a step is waiting for its frame. */
  readonly pending: boolean;
  /** One frame: the clock moves on by a frame and the waiting steps are
   *  taken. False when there were none. */
  frame(): Promise<boolean>;
  /** Frames until nothing asks for another, and how many it took. */
  finish(): Promise<number>;
}

/** Hold `clock` for the rest of `t` — `t.mock` puts the real one back when
 *  the test ends. */
export function holdClock(t: TestContext, clock: AnimationClock): HeldClock {
  let time = 0;
  // By handle, as real timers are: a step disarmed is gone, and two armed
  // at once both run.
  const waiting = new Map<unknown, () => void>();
  t.mock.method(clock, 'now', () => time);
  t.mock.method(clock, 'arm', (step: () => void) => {
    const handle = {};
    waiting.set(handle, step);
    return handle;
  });
  t.mock.method(clock, 'disarm', (handle: unknown) => {
    waiting.delete(handle);
  });
  const held: HeldClock = {
    get pending() {
      return waiting.size > 0;
    },
    async frame() {
      if (waiting.size === 0) return false;
      const due = [...waiting.values()];
      waiting.clear();
      time += FRAME_MS;
      await act(async () => {
        for (const step of due) step();
      });
      return true;
    },
    async finish() {
      let frames = 0;
      while (await held.frame()) {
        // Both are over in well under a second; a hundred frames is one
        // that never ends.
        if (++frames > 100) throw new Error('the animation never ended');
      }
      return frames;
    },
  };
  return held;
}
