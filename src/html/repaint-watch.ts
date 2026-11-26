// A detector for a region that is painted again and again.
//
// A paint of a strip is cheap and invisible when it is right, and a loop that
// repaints the same few hundred pixels every frame — an animation nothing ends,
// a layout that never settles, a hover that flips — looks like flicker and costs
// a core. Nothing else says so, so with `REACT_X11_REPAINT_WATCH=1` every paint
// is counted by the 64-pixel cell of the pane its damage covers, and a cell
// painted `LIMIT` times in a second is reported once, with its rectangle and
// what the document's last change was. `REACT_X11_REPAINT_WATCH=<n>` sets the
// limit. Off, `repaintWatch` is `null` and a paint pays one comparison.

export interface RepaintRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Env = { process?: { env?: Record<string, string | undefined> } };
const raw = (globalThis as Env).process?.env?.REACT_X11_REPAINT_WATCH;
const limit = raw ? (Number(raw) > 1 ? Number(raw) : 20) : 0;

const CELL = 64;
const WINDOW_MS = 1000;

export class RepaintWatch {
  constructor(private readonly max = limit) {}

  private readonly stamps = new Map<string, number[]>();
  private readonly reported = new Set<string>();

  /** Note a paint of `rect` at `now` (ms); answers a message when a cell
   *  of it has been painted too often, once per cell. */
  note(rect: RepaintRect, now: number, why = ''): string | null {
    let message: string | null = null;
    const x1 = Math.floor((rect.x + rect.width - 1) / CELL);
    const y1 = Math.floor((rect.y + rect.height - 1) / CELL);
    for (let cy = Math.floor(rect.y / CELL); cy <= y1; cy += 1) {
      for (let cx = Math.floor(rect.x / CELL); cx <= x1; cx += 1) {
        const key = `${cx},${cy}`;
        const list = this.stamps.get(key) ?? [];
        list.push(now);
        while (list.length && now - list[0] > WINDOW_MS) list.shift();
        this.stamps.set(key, list);
        if (list.length >= this.max && !this.reported.has(key)) {
          this.reported.add(key);
          message ??=
            `@react-x11/components: <Html> painted the region at ` +
            `${cx * CELL},${cy * CELL} (${CELL}px cell, damage ` +
            `${Math.round(rect.x)},${Math.round(rect.y)} ` +
            `${Math.round(rect.width)}x${Math.round(rect.height)}) ` +
            `${list.length} times in a second${why ? `; ${why}` : ''}`;
        }
      }
    }
    return message;
  }
}

/** The detector, or null unless `REACT_X11_REPAINT_WATCH` is set. */
export const repaintWatch: RepaintWatch | null = limit
  ? new RepaintWatch()
  : null;
