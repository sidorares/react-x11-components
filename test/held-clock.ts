// An animation's clock, held: its time moves only when the test says so.
//
// Five things here run on the wall clock on purpose — the maps wheel's glide
// (`glideClock` in ../src/maps/controller.ts), a reorder drop's flight home
// (`flightClock` in ../src/reorder/clock.ts), the march of `<Flow>`'s dashed
// edges (`flowClock` in ../src/flow/node.ts), the virtual window's idea
// of a scroll in flight (`windowClock` in ../src/internal/window.ts) and the
// rest `<Html>` holds a hover for while its content moves under the pointer
// (`hoverClock` in ../src/html/node.ts). Each
// reads the time as it goes, and a timer takes its next step. A runner slow
// enough to spend a step's wait inside one `await` finds the step already
// taken, and each has failed that way. Held, a step is taken when a `frame()`
// the test takes brings the time to it.
//
// It stands in for the clock and nothing else: the event still goes through
// the in-process X server, and the harness's own timers and the component's
// other ones — a settle window, a layout tick — run for real.
//
// Not a `.test.ts` file, so `tsx --test test/*.test.ts` does not run it, but
// `tsconfig.json` does typecheck it.
import type { TestContext } from 'node:test';
import { act } from 'react-x11/test';

/** The shape the clocks share: the time, and a timer for the next step. */
export interface AnimationClock {
  now(): number;
  arm(step: () => void, ms: number): unknown;
  disarm(handle: unknown): void;
}

/** A 60Hz frame — what the glide's and the flight's own timers wait. */
const FRAME_MS = 16;

export interface HeldClock {
  /** Whether a step is waiting for its time. */
  readonly pending: boolean;
  /** One frame: the clock moves on by a frame and the steps due by then
   *  are taken. False when none was waiting. */
  frame(): Promise<boolean>;
  /** Frames until nothing asks for another, and how many it took — for an
   *  animation that ends, which the dashes and the window do not. */
  finish(): Promise<number>;
}

/** Hold `clock` for the rest of `t` — `t.mock` puts the real one back when
 *  the test ends. */
export function holdClock(t: TestContext, clock: AnimationClock): HeldClock {
  let time = 0;
  // By handle, as real timers are: a step disarmed is gone, and two armed
  // at once both run. Each waits what it asked for — a frame for the glide
  // and the flight, longer for the dashes' tick, the window's idle one and
  // a held hover's rest.
  const waiting = new Map<unknown, { step: () => void; at: number }>();
  t.mock.method(clock, 'now', () => time);
  t.mock.method(clock, 'arm', (step: () => void, ms: number) => {
    const handle = {};
    waiting.set(handle, { step, at: time + ms });
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
      time += FRAME_MS;
      const due: (() => void)[] = [];
      for (const [handle, { step, at }] of waiting) {
        if (at > time) continue;
        waiting.delete(handle);
        due.push(step);
      }
      await act(async () => {
        for (const step of due) step();
      });
      return true;
    },
    async finish() {
      let frames = 0;
      while (await held.frame()) {
        // The glide and the flight are over in well under a second; a
        // hundred frames is one that never ends.
        if (++frames > 100) throw new Error('the animation never ended');
      }
      return frames;
    },
  };
  return held;
}
