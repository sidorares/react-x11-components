# PRD: adaptive frame pacing for elements fed off the input path

> **Status: landed upstream; the element half is written but not on master.**
> react-x11 2.9.0 (2026-09-07) took the pacer into core as `frameRate` on
> `<window>`, `<popup>` and `<glarea>`, plus `createRoot({ frameRate })` and
> `REACT_X11_FRAME_RATE`
> ([react-x11#497](https://github.com/sidorares/react-x11/pull/497)) — the
> same three numbers and the same preset names as §4.1, with §11's questions
> answered there and one refinement over §5.1: a token bucket with a burst,
> so a single expensive frame among cheap ones never waits. Two consequences
> for this package. **§4's `frameRate` prop on `<Terminal>` and the
> `<FramePacing>` provider will not be built** — pacing is a property of the
> surface frames go to, so it is the window's policy and an app sets it
> there; `docs/components/terminal.md` says which value, and
> `examples/terminal-vt.tsx` is the menu that walks them. **§6's seams 1 and
> 2 shipped** — `Node.opaqueRect()` (#497) and `globalCompositeOperation` on
> the Cocoa context with a row memcpy for `copy`
> ([#501](https://github.com/sidorares/react-x11/pull/501), over
> `@windowkit/appkit` 0.7.0); seam 4 has a design record
> ([#502](https://github.com/sidorares/react-x11/pull/502)), and seam 3's
> tick-skip is not needed with the pacer above the clock. The floor is
> already `^2.9.1`, so all of it is available here.
>
> **§5.3 — this side's adoption — is done, on the second attempt.**
> `<vtterm>` answers `opaqueRect()` with its grid, composites its surface as
> a `copy`, and subscribes to `onWriteParsed` alone: 3.5s to 1.1s for the §2
> flood on macOS. It took two PRs because the first one never arrived. PR
> [#70](https://github.com/sidorares/react-x11-components/pull/70) was
> opened against `claude/terminal-vt-cocoa-perf-032613`, the branch behind
> [#69](https://github.com/sidorares/react-x11-components/pull/69), and
> merged into it _after_ #69 had already been squash-merged — so GitHub
> calls #70 merged while master got only this document, and for a while
> `<vtterm>` answered no `opaqueRect()` and still subscribed to `onScroll`
> beside `onWriteParsed`. Commit `da84494` is the original; it was re-landed
> onto master unchanged in substance. **A PR whose base is not `master` does
> not reach `master`** — worth remembering the next time work is stacked.
>
> The measurements in §2 and §9 were taken on 2026-09-07 against react-x11
> 2.6.1 (the version pinned then) and re-checked against the 2.8.2 source
> for the seams §6 names. The numbers are from one machine — an M1 Pro with
> a 120 Hz panel — and the shape of the result, not its third digit, is what
> the design rests on.

`<Terminal backend="vt">` repaints whenever the emulator says the screen may
have changed, and leaves _when_ to react-x11's frame clock. On X11 that is
the right division of labour: the frame is fenced by a server round trip, so
a flood of output paints as often as the server can keep up and no more. On
the Cocoa backend the frame clock is the display's own period and every
frame's pixel work runs synchronously on the JS thread, so the same flood
paints at 120 Hz and spends most of its wall time painting screens nobody can
read. `time find ~` in a vt terminal is four times slower on Cocoa than under
XQuartz on the same machine, and the difference is entirely frame count times
per-frame cost.

This document specifies the fix that needs nothing from core — an adaptive
repaint pacer owned by the element — as a public prop with sensible presets,
a way for an app to set the default once, and the shape that lets other
elements in this package (a media player's frames, a streaming chart) adopt
the same mechanism. §6 records what core would have to grow for the rest of
the gap, so that the follow-ups are filed rather than folklore.

## 1. Summary

- **One number decides throughput during a flood: what share of wall time
  the element's paints take.** On Cocoa today it is 60%. Capping it at 20–25%
  by deferring claims when frames are expensive makes the flood 3.3–3.9×
  faster and lands within 10–25% of XQuartz, which is itself bound by how fast
  the pty delivers.
- **The pacer is a rule, not a rate.** A claim is deferred until
  `lastPaintEnd + cost × (1/budget − 1)`, clamped by a floor and an optional
  ceiling. A keystroke after a quiet moment never waits, a cheap frame is
  never deferred, and a flood that ends is un-throttled on the next claim.
- **The API is one prop, `frameRate`,** taking a preset, a number, or three
  fields (`budget`, `minFps`, `maxFps`), plus a provider and an environment
  variable for app-wide defaults. Default: `'adaptive'`.
- **Where it lives:** `src/internal/frame-pacer.ts` first, with `<Terminal>`
  as the one adopter; promoted to a `src/pacing/` shared module with its own
  subpath when a second element adopts it or an app wants the provider —
  AGENTS.md's documented promotion path.
- **Nothing upstream blocks it.** The pacer needs `invalidate` and the
  node's own `paint`, both public. The four seams in §6 are what the
  remaining per-frame cost needs, and they are the same seams any drawn
  element with an opaque retained surface would want.

## 2. The problem, measured

The setup: a 1000×700 logical window at 2× on a 120 Hz panel, a `<Terminal
backend="vt">` filling it (a 125×45 grid at `fontSize` 13), and 300,000
_distinct_ lines (36.6 MB) `cat`-ed into the pty by the shell it runs. The
wall time is from the first byte of the flood reaching the pty reader to the
last, which is when the emulator has consumed everything but the flow-control
watermark. "Paint share" is the time inside `VtTermNode.paint` over that wall
time, measured by wrapping the method.

| variant                                                 |  flood | paints/s | paint share |
| ------------------------------------------------------- | -----: | -------: | ----------: |
| Cocoa, defaults (surface presenter, display clock)      | 3.50 s |      110 |         60% |
| Cocoa, `createRoot({ cocoa: { frameInterval: 16.7 } })` | 1.40 s |       63 |         35% |
| Cocoa, `frameInterval: 33.3`                            | 1.08 s |       34 |         21% |
| X11 (XQuartz), defaults                                 | 0.85 s |       35 |          7% |
| Cocoa, the pacer of §5 (4× gap, 50 ms floor)            | 0.95 s |       35 |         20% |
| Cocoa, one claim per frame and nothing else             | 3.29 s |      114 |         59% |
| Cocoa, layers presenter                                 | 6.35 s |       38 |         22% |

Three facts fall out of the table and the CPU profiles behind it.

**Frame count is the lever.** Both backends run the frame clock at the
display's period — under XQuartz too, since x11-dri reports the panel's real
rate to ntk — but under XQuartz the X11 frame is _fenced_: ntk sends a
`GetInputFocus` after each frame's requests and does not start the next
until the reply confirms the server consumed them (`ntk/lib/window.js`,
"Frame clock"). The
server takes about 28 ms to composite a screenful of glyphs, so the element
paints 35 times a second by backpressure and never asked for it. The Cocoa
backend has no equivalent: its "server" is CoreGraphics on the JS thread, the
frame is due whenever the display is (`src/cocoa/app.js`, `_frameDue`), and
the only thing pacing a flood is the flood.

**Per-frame cost on Cocoa is full-area memory passes, not glyphs.** The
profile of the 110 fps run, per frame:

| pass                                           |   cost | what it is                                                                                        |
| ---------------------------------------------- | -----: | ------------------------------------------------------------------------------------------------- |
| cell backgrounds, `ctx.fillRects`              |  2.0ms | `CGContextFillRects` over the whole grid — bandwidth, not call count                              |
| `present()`, `ctx.drawImage(surface → window)` |  1.7ms | `CGBitmapContextCreateImage` + `CGContextDrawImage` of the whole grid (`renderer.ts:452`)         |
| node and window background, `ctx.fillRect`     |  0.7ms | `Node._paintBackground` and `_paintWindowBackground`, both under an opaque surface                |
| swapchain catch-up, `copySurfaceRegion`        | 0.95ms | the window's `present()` copying this frame's damage into the other IOSurface (`cocoa/window.js`) |
| `Surface.copyWithin`                           |  0.4ms | the scroll band, where one survived                                                               |
| `readViewport`                                 | 0.25ms | resolving 5,625 cells                                                                             |
| `ctx.drawGlyphs`                               | 0.26ms | `CTFontDrawGlyphs` — CoreText's glyph cache is doing its job                                      |
| the mirror diff                                |     ~0 |                                                                                                   |

Roughly 6 ms a frame, four or five of them passes over a 12 MB bitmap. The
retained-surface design of `docs/prd-vt-terminal.md` §7 is sound; what it
did not anticipate is a backend where "one composite" is a CPU copy and the
frame clock has no fence. On X11 the same frame costs the JS thread 2 ms,
all of it encoding requests.

**The claim storm is not the problem, but it is untidy.** `term.onScroll`
fires once per scrolled line (`BufferService.scroll` in xterm.js), so the
flood made 336,000 `invalidate` calls. They cost 69 ms — 2% of the wall time
on either backend — because `WindowNode.invalidate` is cheap after the first
claim of a frame. Gating to one claim per frame on its own buys 6% on Cocoa
(row six of the table). It is worth doing as hygiene, and it is not the
lever.

## 3. Goals and non-goals

### Goals

- **P0 — throughput under a flood on Cocoa within 1.5× of X11**, without
  changing what a frame draws or touching core. Measured: 0.95 s against
  0.85 s.
- **P0 — no latency regression at low load.** A keystroke's echo, a cursor
  blink, a prompt redraw must paint on the same frame they do today. The
  pacer must be provably inert for cheap frames.
- **P0 — a public prop with presets** an app author can reason about without
  reading this document, and a documented default.
- **P1 — app-wide configuration**: set it once for every pacing element in
  the tree, and override it from the environment for an A/B run, the way
  core's `REACT_X11_BACKEND` works.
- **P1 — reusable by other elements** fed off the input path: `<MediaPlayer>`
  frames, a streaming `<Chart>` series, `<Markdown>` streaming. Same rule,
  same options, same provider.
- **P1 — observable**: the decisions the pacer makes are counters on
  `rendererStats`, so the draw-op budget tests of `test/terminal-vt.test.ts`
  can assert the contract and a bench can print it.

### Non-goals

- **Changing react-x11's frame clock.** An adaptive clock in core is the
  general fix (§6.3) and belongs upstream; this design must work on the
  pinned core and degrade to today's behaviour when told to.
- **Reducing the per-frame cost.** That is §6's list: skipping the wasted
  background fills, an opaque copy blit on Cocoa, an element-owned layer.
  Each is independent of pacing and each is filed separately.
- **Dropping frames the program asked for.** A TUI animation on the
  alternate screen gets the same rule as everything else; the opt-out is
  `frameRate="display"`, not a heuristic about which programs deserve every
  frame (§11, Q4).
- **Pacing input.** Keyboard and mouse still go straight to the pty; nothing
  here sits between the user and the program.

## 4. Public API

### 4.1 `frameRate` on `<Terminal>`

Added to `TerminalProps` beside `cursorBlink` and `scrollback`, honoured by
the vt backend and ignored by the embedded ones (an embedded xterm paces
itself):

```ts
export type FrameRate =
  /** The default: paint every frame while frames are cheap, defer claims
   *  when they are expensive, so paints stay under a share of wall time. */
  | 'adaptive'
  /** Today's behaviour: every claim lands on the next frame the clock gives.
   *  For a program whose every frame matters. */
  | 'display'
  /** Heavy-output bias: fewer, later frames; the screen may lag by up to
   *  100 ms during a flood. */
  | 'throughput'
  /** A hard cap in frames per second, adaptive underneath. */
  | number
  /** The three numbers the presets are made of. Any subset; the rest are
   *  the `'adaptive'` values. */
  | {
      /** Share of wall time paints may take while busy, 0–1. */
      budget?: number;
      /** The floor: the screen is never more than `1000 / minFps` ms behind. */
      minFps?: number;
      /** A ceiling on top of the display's rate. */
      maxFps?: number;
    };

interface TerminalProps {
  frameRate?: FrameRate; // default 'adaptive'
}
```

```tsx
<Terminal backend="vt" />; // adaptive
<Terminal backend="vt" frameRate={30} />; // never more than 30 fps
<Terminal backend="vt" frameRate="display" />; // a TUI that wants every frame
<Terminal backend="vt" frameRate={{ budget: 0.1, minFps: 10 }} />;
```

The presets, resolved:

| preset         | `budget` | `minFps` | `maxFps` | measured flood (§2, §9)           |
| -------------- | -------: | -------: | -------: | --------------------------------- |
| `'adaptive'`   |     0.25 |       20 |     none | 1.19 s (3× gap), 1.13 s (4× gap)  |
| `'throughput'` |      0.1 |       10 |       30 | not measured; 33.3 ms cap: 1.08 s |
| `'display'`    |        1 |     none |     none | 3.50 s — today                    |
| `30`           |     0.25 |       20 |       30 | see `'throughput'`                |

Why these three numbers and no others: `budget` is the one that decides
throughput (§2), `minFps` is the promise about staleness that makes a budget
safe to default, and `maxFps` is the knob every other terminal already has —
WezTerm's `max_fps`, kitty's `repaint_delay`, iTerm2's adaptive frame rate
under "maximize throughput". Anything finer (a burst allowance, a separate
budget for the alternate screen) is a rule the pacer can grow without a new
option, and §11 lists the ones considered.

A number means "cap it", with the adaptive rule still underneath; an app
that wants a fixed 30 fps with no adaptation says `{ maxFps: 30, budget: 1 }`.

### 4.2 App-wide defaults

Three sources, in precedence order:

1. **`REACT_X11_COMPONENTS_FRAME_RATE`** — `adaptive`, `display`,
   `throughput`, or a number. Overrides everything, the way core's
   `REACT_X11_BACKEND` overrides `createRoot({ backend })`: an A/B run and a
   field diagnosis should not need a code change. Read once per process,
   through `globalThis.process?.env` under the `types: []` idiom every
   component uses.
2. **The element prop.**
3. **`<FramePacing frameRate={…}>`** — a React context provider that sets the
   default for every pacing element beneath it. Ships with the promotion to
   `src/pacing/` (§5.2); until then the prop is the only in-tree knob, which
   is enough for the first adopter.
4. **The built-in default**, `'adaptive'`.

The provider is deliberately not a theme token: `frameRate` is a behaviour,
not an appearance, and a theme swap must not change how a flood paints.

### 4.3 Instrumentation

`rendererStats` (node.ts:1238) grows a `pacing` block beside `stats` and
`totals`:

```ts
pacing: {
  mode: 'adaptive' | 'display' | 'throughput' | 'custom';
  claims: number; // request() calls
  deferred: number; // claims that waited on the timer
  coalesced: number; // claims dropped because one was already pending
  frames: number; // paints
  lastCostMs: number; // the paint the next gap is computed from
  lastGapMs: number; // what that gap was
}
```

The bench script prints it; the tests assert against it (§8).

## 5. Design

### 5.1 The pacer

One class, owned by the node, replacing the direct `invalidate` in
`_repaint` (node.ts:454) and told about every paint:

```ts
// src/internal/frame-pacer.ts — no React, no node, no timers of its own
export class FramePacer {
  constructor(
    private claim: () => void, // the node's invalidate
    private clock: {
      now(): number;
      after(ms: number, fn: () => void): () => void;
    },
    options: FrameRateOptions,
  ) {}

  request(): void {
    const now = this.clock.now();
    // One claim per frame — with a guard, because a claim that never turned
    // into a paint (the node hidden, the window unmapped) must not swallow
    // every claim after it. Two floors is the longest a paint can be late
    // by and still be a paint this frame was waiting for.
    if (this.pending && now - this.pendingSince < 2 * this.maxDelay) {
      this.coalesced++;
      return;
    }
    const gap = clamp(
      this.lastCost * (1 / this.budget - 1),
      this.minGap, // 1000 / maxFps, or 0
      this.maxDelay, // 1000 / minFps, or Infinity
    );
    const due = this.lastPaintEnd + gap;
    if (now >= due) return this.claimNow(now);
    if (!this.timer) {
      this.deferred++;
      this.timer = this.clock.after(due - now, () => {
        this.timer = null;
        if (!this.pending) this.claimNow(this.clock.now());
      });
    }
  }

  painted(startedAt: number): void {
    this.pending = false;
    this.lastPaintEnd = this.clock.now();
    this.lastCost = this.lastPaintEnd - startedAt;
    this.frames++;
  }
}
```

Four properties follow from the rule, and they are what the tests pin:

- **Idle → immediate.** The gap is measured from the _last paint's end_, so
  a claim after a quiet moment is already past due. A keystroke never waits.
- **Cheap → unthrottled.** A cursor blink or an echoed character costs well
  under a millisecond; at `budget: 0.25` the gap is under 3 ms, which is
  inside the frame interval on any display, so the claim lands on the same
  frame it does today.
- **Expensive → paced, self-correcting.** A full-screen frame costing 5 ms
  yields a 15 ms gap: about 50 fps at 120 Hz, 35–40 fps once the frame
  interval rounds it. The cost is the _last_ paint's, not an average, so the
  first cheap frame after a flood restores full rate. An average would keep
  throttling the prompt that appears when the flood ends.
- **Never more than `maxDelay` behind.** Whatever the load, a deferred claim
  fires within the floor. The floor is a promise about staleness; it is not
  a guaranteed rate, because a single paint can take longer than it.

The timer is one-shot and at most one is armed; a second `request()` while
it is armed is a no-op. On Node the timer is `unref`'d where the global
offers it, so a pending deferral never keeps a process alive that is
otherwise done — the same care `embed/timers.ts` takes with the poll delay.

### 5.2 Where it lives

- **M1:** `src/internal/frame-pacer.ts` — the class, the option resolver
  (preset → three numbers), the environment override. `src/internal/` is the
  half-step for code components share and no app needs to import; the
  terminal is the only consumer and the prop is the only public surface.
- **Promotion:** when `<MediaPlayer>` or a streaming chart adopts it, or an
  app wants `<FramePacing>`, the module moves to `src/pacing/` with an
  `index.ts`, a `docs/components/pacing.md` page and the
  `@react-x11/components/pacing` subpath — exactly the path AGENTS.md
  reserves ("giving it an `index.ts` and the full shared-module treatment is
  the promotion path"). It exports `FramePacer`, `resolveFrameRate`,
  `FramePacing` and `useFrameRate`, and stays side-effect free.

The class takes its clock and timer through the constructor rather than
reaching for `performance.now` and `setTimeout` itself. That is what makes
it unit-testable with a fake clock under `node --test`, and it is the
`types: []` idiom anyway: the node hands it the globals through the
structural `timers.ts` wrappers this directory already has.

### 5.3 Wiring into `<vtterm>`

Four changes in `src/terminal/vt/node.ts`, none of which touch the renderer,
the mirror or the diff:

1. `_repaint()` (node.ts:454) becomes `this._pacer.request()`. The pacer's
   `claim` is `() => this.invalidate(false, this, 'text')`, unchanged.
2. `paint()` (node.ts:463) stamps `performance.now()` on entry and calls
   `this._pacer.painted(startedAt)` on exit, on every path out — including
   the early returns for "no fonts" and "no term", so a claim that painted
   nothing still clears `pending`.
3. `_attach()` (node.ts:232) stops subscribing to `term.onScroll` and
   `term.onCursorMove`. `onWriteParsed` fires once per parsed batch and
   covers every change program output can make; the two user-driven scrolls
   the node performs itself — `scrollLines` (node.ts:1210), `scrollToBottom`
   (node.ts:1215) and `handleWheel` (node.ts:1021) — already call
   `_repaint()`, and `_typed()` (node.ts:836) gains the one it was relying on
   `onScroll` for. `onResize` and `onBufferChange` stay: they invalidate the
   mirror, which is a different claim.
4. `applyProps` resolves `frameRate` (prop, then provider, then default, with
   the environment override on top) and reconfigures the pacer in place; a
   change of mode resets `lastCost` so `'display'` takes effect on the next
   claim rather than after the next paint.

`rendererStats` reports the pacer's counters (§4.3). Nothing else in the
node knows the pacer exists.

### 5.4 How it composes with core's frame clock

The pacer defers _claims_; core still decides _frames_. A deferred claim
that fires at `due` is painted on the next frame tick after it, so the
effective cadence is the gap rounded up to the display's period, and the
pacer's timer resolution never has to be finer than the clock's:

- **Cocoa:** the window's clock is the display's period
  (`CocoaApp.frameIntervalFor`), an 8 ms pump plus a one-shot timer for
  frames due between ticks. `createRoot({ cocoa: { frameInterval } })`
  remains a global cap on top; the two compose, and the pacer is the one
  that only acts on the element whose frames are expensive.
- **X11:** the fence already paces to the server. The pacer's gap is
  computed from the JS-side cost (2 ms here), so it rarely defers, and the
  measured result is unchanged within noise (0.85 s → 0.76–0.85 s). That is
  the point: the pacer is inert where the backend already has backpressure.
- **Discrete input:** core flushes pending damage synchronously when a click
  or key is dispatched (`frames.js`). A deferred claim is not damage yet, so
  that flush does not paint the terminal's pending content early. It does
  not need to: the keystroke's own echo is a fresh claim after the flush,
  and it lands immediately by the idle rule.

## 6. Upstream: the seams the rest of the gap needs

None of these blocks §5. Each is filed separately, adopted by bumping the
react-x11 floor, and each is a seam any drawn element with an opaque retained
surface would want, not a terminal special case. Checked against react-x11
2.8.2 (`~/Projects/react-x11`, master).

| #   | seam                                                                                                                                                                               | what it closes                                                                                                                                       | today                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **An opaque-content hint on `Node`** — `opaqueRect()` or a flag: "my content box is fully covered, opaque, every frame"                                                            | the two background fills under the surface (0.7 ms), and it lets `present()` composite only the dirty rows via the public `paintDamage()`            | `Node.paint` always fills `style.backgroundColor` (private `_paintBackground`), and `_paintWindowBackground` fills the whole damage rect under every pass. The node half has a public workaround: keep `backgroundColor` out of the vt element's style and paint the padding ring in `paintContent`                                       |
| 2   | **`globalCompositeOperation` on the Cocoa context**, with a memcpy path for `'copy'` on a translate-only transform at equal size                                                   | the `present()` composite (1.7 ms → ~1 ms), and `Surface.copyWithin` stays as is                                                                     | ntk documents the property (`docs/context-2d.md`) and its `drawImage` honours it as `PictOp.Src`; `CocoaContext2D` has no such property, and the bridge's `ctxDrawSurface` is always `CGBitmapContextCreateImage` + `CGContextDrawImage`, although `copySurfaceRegion` — a row memcpy — is in the same file                               |
| 3   | **A `frameInterval` prop on `<window>` for both backends, and an adaptive tick-skip in the Cocoa clock** (a frame whose flush overran a share of the interval skips the next tick) | the general case: every element, not just the ones that adopted the pacer                                                                            | `createRoot({ cocoa: { frameInterval } })` is creation-time and Cocoa-only; ntk's window has a public `frameInterval` setter but a node has no path to its window (`Node.root` is an empty `WindowNode` type, `NtkApp` is `[key: string]: any`); nothing in `_frameDue` looks at cost. react-x11#190 is the open home for render policies |
| 4   | **Element-owned layer contents** — `presentSurface()` on a node, plus an IOSurface-backed `Surface` option                                                                         | on Cocoa, `present()` and the swapchain copy disappear (2.65 ms of the 6): the terminal's surface _is_ its layer, the way `<glarea>` already has one | layer promotion (react-x11#483) is policy-only — "no style prop", animated property boxes only — and a promoted node's content is re-rastered and uploaded through `surfaceToLayer`; `CocoaSurface` is a plain CG bitmap with no backing option                                                                                           |

Typing gaps found on the way, worth a small PR of their own: `Context2D` is
`unknown` in `node.d.ts`, so the drawing contract exists only by reference to
ntk's docs and every renderer declares its own structural slice
(`renderer.ts`'s `CellContext`); `paintContent`, `paintCachePlan` and
`paintCached` are documented in `docs/extending.md` and undeclared.

If seam 3's coalescing half ever lands as an `invalidate` option — say
`invalidate(layout, damage, reason, { budget, minFps })` — the three numbers
of §4.1 are its vocabulary, the pacer delegates, and `<FramePacing>` maps onto
the root option. App configuration written against this document carries
over unchanged; that is the reason to spend the three numbers now rather than
a one-off `throttle` boolean.

## 7. Performance targets

Asserted by the bench (§9) on the machine that runs it, as ratios rather than
milliseconds so the gate survives a faster laptop:

| metric                                                   | target                       |
| -------------------------------------------------------- | ---------------------------- |
| paint share of wall time, `'adaptive'`, Cocoa flood      | ≤ 30% (measured 19–24%)      |
| flood wall time, `'adaptive'` vs `'display'`, Cocoa      | ≤ 0.4× (measured 0.28–0.30×) |
| flood wall time, `'adaptive'` vs X11 defaults            | ≤ 1.5× (measured 1.1–1.4×)   |
| frames deferred at low load (typing, blinking) over 10 s | 0                            |
| longest gap between a claim and its paint during a flood | ≤ 1000 / minFps + one frame  |
| `invalidate` calls per parsed batch                      | ≤ 1                          |

## 8. Testing

**The pacer, alone** (`test/frame-pacer.test.ts`, a fake clock, no display):

- idle: a request with `now ≥ lastPaintEnd + gap` claims synchronously;
- cheap: `lastCost` of 0.3 ms at `budget: 0.25` yields a gap under the
  8.33 ms frame and the claim is not deferred;
- expensive: `lastCost` of 5 ms defers by 15 ms, one timer, later requests
  coalesce into it, and the claim fires once at `due`;
- the floor: `lastCost` of 40 ms at `minFps: 20` defers by 50 ms, not 120;
- the ceiling: `maxFps: 30` never claims sooner than 33.3 ms after the last
  paint, cheap frames included;
- the stuck-claim guard: a `pending` older than `2 × maxDelay` is re-issued;
- `'display'` never defers; a number resolves to a cap over `'adaptive'`;
- the environment override beats the prop, the prop beats the provider.

**The node, on the mock backend** (`test/terminal-vt.test.ts`, the existing
`FakePtyHost`):

- a fed keystroke repaints on the next `act`, as today (the idle rule);
- a fed screenful with a stubbed `paint` cost defers the second claim and
  `rendererStats.pacing.deferred` goes up;
- feeding 200 lines raises `pacing.claims` by the number of parsed batches,
  not lines — the `onScroll` change;
- `scrollToBottom` from `_typed` still repaints with `onScroll` gone.

**The flood, on a real display** (`scripts/bench/terminal-flood.ts`,
promoted from the scratch script in §9): both backends, the presets, the
§7 ratios as a gate, and the profile summary of §2 under `--prof`. Not CI —
it needs a display and a pty — but the numbers in this document are its
output, and a change to the renderer owes it a run.

## 9. The bench, and the second session's numbers

The recipe, so the table can be reproduced without this branch: a scratch
`examples/zz-*.tsx` (not a dotfile; move it out before `npm run typecheck`)
rendering a `<window>` with a `<Terminal backend="vt">` whose `pty` wraps
`defaultPtyHost()` to timestamp two marker lines in `session.onData`, and
whose `command` is `/bin/sh -c 'sleep 1.5; echo START; cat FILE; echo DONE;
sleep 60'`. Wrap `VtTermNode.prototype.paint` and `invalidate` to count.
The file has to be _distinct_ lines — `awk` printing the line number into
each — because a repeated identical line hashes equal after every scroll and
the mirror diff draws nothing. `node --cpu-prof --import tsx` for the
profile. macOS ptys deliver ~1 KB chunks and cap the producer near 45 MB/s,
which is why the X11 run is half idle.

Second session, same setup, the machine a little slower (the `'display'`
baseline came in at 3.99 s):

| gap multiplier (`1/budget − 1`) | budget |  flood | paints/s | paint share |
| ------------------------------: | -----: | -----: | -------: | ----------: |
|                              1× |    0.5 | 1.54 s |       62 |         36% |
|                              3× |   0.25 | 1.19 s |       41 |         24% |
|                              4× |    0.2 | 1.13 s |       33 |         20% |
|                              6× |   0.14 | 1.03 s |       26 |         15% |
|            X11, 3×, for control |   0.25 | 0.85 s |       37 |          7% |

The default is not sensitive between 3× and 6×; `'adaptive'` takes 0.25 as
the value with the least latency cost, and `'throughput'` takes the other
end.

## 10. Milestones

- **M1 — the pacer and the prop.** `src/internal/frame-pacer.ts`,
  `frameRate` on `<Terminal>`, the `_attach` subscription change, the
  environment override, `rendererStats.pacing`, the unit and node tests, the
  `docs/components/terminal.md` row, and the bench script under
  `scripts/bench/`. One PR.
- **M2 — the provider.** Promotion to `src/pacing/` with `<FramePacing>`,
  `useFrameRate`, the page and the subpath. Triggered by the first second
  adopter or the first app that asks; not before.
- **M3 — adoption.** `<MediaPlayer>` frames on the embedded path do not
  need it (the player paints its own window); the vt path's future
  `<TerminalOutput>` streaming and a `<Chart>` fed by `store.append` do.
- **M4 — the upstream seams**, each adopted by a floor bump as it lands, in
  the order of §6's table.

## 11. Open questions (decision needed, defaults proposed)

- **Q1 — the prop's name.** `frameRate` (proposed: it is what app authors
  think in, and the numeric form reads as a cap), against `repaint` or
  `pacing`.
- **Q2 — environment precedence.** Proposed: the variable overrides the
  prop, matching `REACT_X11_BACKEND`. The alternative, prop over
  environment, makes an A/B run need a code change in every app.
- **Q3 — the numeric form.** Proposed: a cap with `'adaptive'` underneath.
  The alternative, a fixed rate with no adaptation, is spelled
  `{ maxFps: n, budget: 1 }`.
- **Q4 — the alternate screen.** A full-screen TUI animation costs 5 ms a
  frame on Cocoa and would be paced to ~40 fps by the default. Proposed: no
  exemption; `frameRate="display"` is the opt-out, and a program that
  redraws a whole 125×45 screen every 8 ms is asking for the same thing a
  flood is. Revisit if a real TUI shows the difference.
- **Q5 — what "cost" is.** Proposed: the JS-side duration of `paint`. On X11
  it undercounts the server's work, and that is fine because the fence
  pays for it; a core seam reporting the whole flush's cost would make the
  rule exact on both backends, and is a note on §6.3 rather than a blocker.
- **Q6 — several terminals.** Each paces itself; four floods at once could
  take four budgets. Proposed: accept it. A shared budget needs a process
  level clock that is core's to own (§6.3).

## 12. Risks

- **A swallowed claim leaves a stale screen.** The one-claim gate is the
  danger: `pending` set with no paint to clear it. Mitigated by the
  time-bounded guard in `request()`, by clearing `pending` on every exit
  from `paint`, and by `applyProps` resetting the pacer. A later paint of
  any kind repairs the screen regardless, because paint reads the live
  buffer.
- **A latency regression nobody measured.** The idle and cheap rules are
  pinned by tests with a fake clock, and the bench's "frames deferred at
  low load" target is zero. The escape hatch is one environment variable.
- **Presets drift from the numbers that justified them.** The bench gate
  (§7) is the check; a renderer change that moves the per-frame cost owes
  it a run.
- **The timer keeps a process alive.** `unref` where available, and at most
  one timer of at most `maxDelay` — 50 ms by default.
