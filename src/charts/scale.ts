// Scales and ticks: the d3-shaped 20% of d3-scale these charts need,
// written out rather than depended on. Pure functions over numbers — no
// react-x11, no ntk — so every branch is unit-testable headlessly.

/** A linear mapping from a data domain onto a pixel range. `r0 > r1` is the
 * normal state for y (pixels grow downward). */
export interface LinearScale {
  kind: 'linear';
  d0: number;
  d1: number;
  r0: number;
  r1: number;
  scale(v: number): number;
  invert(px: number): number;
}

export function linearScale(
  d0: number,
  d1: number,
  r0: number,
  r1: number,
): LinearScale {
  // a degenerate domain still has to map *somewhere*: pin it to the middle
  // of the range rather than dividing by zero
  const span = d1 - d0;
  const k = span === 0 ? 0 : (r1 - r0) / span;
  return {
    kind: 'linear',
    d0,
    d1,
    r0,
    r1,
    scale: (v) => (span === 0 ? (r0 + r1) / 2 : r0 + (v - d0) * k),
    invert: (px) => (k === 0 ? d0 : d0 + (px - r0) / k),
  };
}

/** A band mapping for categories: index → left edge, with the usual inner
 * padding. Bars ask for `bandwidth`; ticks ask for `center`. */
export interface BandScale {
  kind: 'band';
  count: number;
  r0: number;
  r1: number;
  bandwidth: number;
  step: number;
  scale(index: number): number;
  center(index: number): number;
  indexAt(px: number): number;
}

export function bandScale(
  count: number,
  r0: number,
  r1: number,
  paddingInner = 0.2,
  paddingOuter = 0.1,
): BandScale {
  const n = Math.max(1, count);
  const span = r1 - r0;
  // solve span = step * (n - paddingInner) + 2 * paddingOuter * step
  const step = span / Math.max(1e-9, n - paddingInner + 2 * paddingOuter);
  const bandwidth = Math.max(1, step * (1 - paddingInner));
  const start = r0 + step * paddingOuter;
  return {
    kind: 'band',
    count: n,
    r0,
    r1,
    bandwidth,
    step,
    scale: (i) => start + step * i,
    center: (i) => start + step * i + bandwidth / 2,
    // nearest band center, clamped — the tooltip's question
    indexAt: (px) =>
      Math.max(
        0,
        Math.min(n - 1, Math.round((px - start - bandwidth / 2) / step)),
      ),
  };
}

// --- nice numeric ticks ----------------------------------------------------

/** The classic 1-2-5 ladder: the largest of {1,2,5}·10^k not above `raw`. */
function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const unit = raw / pow;
  if (unit >= 5) return 5 * pow;
  if (unit >= 2) return 2 * pow;
  return pow;
}

/**
 * Tick values covering `[d0, d1]` at a nice step, aiming for `target`
 * ticks. Values land on multiples of the step, so labels come out as the
 * round numbers a person would have chosen.
 */
export function linearTicks(d0: number, d1: number, target = 5): number[] {
  if (!Number.isFinite(d0) || !Number.isFinite(d1)) return [];
  if (d1 < d0) [d0, d1] = [d1, d0];
  if (d0 === d1) return [d0];
  const step = niceStep((d1 - d0) / Math.max(1, target));
  const start = Math.ceil(d0 / step) * step;
  const ticks: number[] = [];
  // the epsilon keeps a tick sitting exactly on d1 from being dropped to
  // float noise
  for (let v = start; v <= d1 + step * 1e-9; v += step) {
    // snap accumulated float error back onto the step grid
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return ticks;
}

/** Widen `[d0, d1]` outward onto the tick grid — what "nice: true" domains
 * mean everywhere else. */
export function niceDomain(
  d0: number,
  d1: number,
  target = 5,
): [number, number] {
  if (!Number.isFinite(d0) || !Number.isFinite(d1) || d0 === d1) {
    // a flat or empty domain gets a unit of air so the line is visible and
    // the scale is invertible
    const v = Number.isFinite(d0) ? d0 : 0;
    return [v - 1, v + 1];
  }
  if (d1 < d0) [d0, d1] = [d1, d0];
  const step = niceStep((d1 - d0) / Math.max(1, target));
  return [Math.floor(d0 / step) * step, Math.ceil(d1 / step) * step];
}

// --- time ticks ------------------------------------------------------------

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Steps a person expects a time axis to move in, smallest first. Above a
 * month the numeric 1-2-5 ladder over days takes over — calendars stop
 * being uniform there and this is a chart axis, not a scheduler. */
const TIME_STEPS = [
  SEC,
  5 * SEC,
  15 * SEC,
  30 * SEC,
  MIN,
  5 * MIN,
  15 * MIN,
  30 * MIN,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
];

export function timeTicks(d0: number, d1: number, target = 5): number[] {
  if (!Number.isFinite(d0) || !Number.isFinite(d1) || d1 <= d0) return [];
  const raw = (d1 - d0) / Math.max(1, target);
  let step = TIME_STEPS[TIME_STEPS.length - 1];
  for (const s of TIME_STEPS) {
    if (s >= raw) {
      step = s;
      break;
    }
  }
  if (raw > step) step = niceStep(raw / DAY) * DAY;
  const ticks: number[] = [];
  for (let v = Math.ceil(d0 / step) * step; v <= d1; v += step) ticks.push(v);
  return ticks;
}

/** A label for a time tick, sized to the span it lives in: a minutes-wide
 * window shows H:MM:SS, a months-wide one shows "Mar 4". Local time. */
export function formatTimeTick(v: number, span: number): string {
  const d = new Date(v);
  const two = (x: number) => String(x).padStart(2, '0');
  if (span < MIN) return `${two(d.getMinutes())}:${two(d.getSeconds())}`;
  if (span < HOUR)
    return `${d.getHours()}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  if (span < 2 * DAY) return `${d.getHours()}:${two(d.getMinutes())}`;
  const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  if (span < 300 * DAY) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Compact numeric labels: 1200000 → "1.2M". What axis gutters can afford. */
export function formatNumberTick(v: number): string {
  if (v === 0) return '0';
  const abs = Math.abs(v);
  const fmt = (scaled: number, suffix: string) => {
    const rounded =
      Math.abs(scaled) >= 100
        ? Math.round(scaled)
        : Math.round(scaled * 10) / 10;
    return `${rounded}${suffix}`;
  };
  if (abs >= 1e9) return fmt(v / 1e9, 'B');
  if (abs >= 1e6) return fmt(v / 1e6, 'M');
  if (abs >= 1e3) return fmt(v / 1e3, 'k');
  if (abs >= 1) {
    const r = Math.round(v * 100) / 100;
    return String(r);
  }
  // small magnitudes keep enough digits to tell ticks apart
  const digits = Math.min(6, 1 - Math.floor(Math.log10(abs)));
  return v.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}
