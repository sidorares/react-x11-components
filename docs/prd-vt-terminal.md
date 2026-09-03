# PRD: a pure-JS VT backend for `<Terminal>`

> **Status: implemented.** This is the document
> [issue #19](https://github.com/sidorares/react-x11-components/issues/19)
> carries, kept here as the record of why the renderer is shaped the way it
> is. Two things about it are now history rather than plan:
>
> - **Every upstream promotion in §11 landed before this shipped** —
>   [ntk#252](https://github.com/sidorares/ntk/issues/252)
>   (`Surface.copyWithin`),
>   [ntk#253](https://github.com/sidorares/ntk/issues/253) (`ctx.fillRects`),
>   [ntk#254](https://github.com/sidorares/ntk/issues/254)
>   (`Font.glyphIdFor` + the documented `drawGlyphs` run contract),
>   [react-x11#283](https://github.com/sidorares/react-x11/issues/283) and
>   [react-x11#284](https://github.com/sidorares/react-x11/issues/284)
>   (`altKey`/`metaKey` on synthetic events). So there are **no escape
>   hatches in the shipped code**: the retained renderer is public API top to
>   bottom, and `keys.ts` reads the modifiers off the event. What remains of
>   the table is the two upstream requests to xterm.js (mouse _encoding_ in
>   `IModes`, underline colour on `IBufferCell`), which are still open and
>   still worked around exactly as §10.3 and §10.4 describe.
> - **M1 and M2 shipped together**, plus the parts of M3 that fell out of the
>   same seams: mouse reporting, bracketed paste, OSC 52 (write-only), the
>   visual bell. M3's box-drawing glyphs, bold overstrike and the right-click
>   menu, and all of M4, are not built.
>
> One fact the PRD could not have known, found while wiring the core up:
> `@xterm/headless` 6.0 gates `term.buffer`, `term.parser` and `term.modes`
> behind `allowProposedApi: true` — `term.buffer` _throws_ without it. The
> component sets the flag; the slice we use is written out structurally in
> `vt/xterm.ts` and the version is pinned, which is the mitigation §16
> already asks for.

---

The VT-emulator half of #7's "Terminal emulator and media player" — the _"pure-JS fallback later"_ the issue sketches, now specified. Full PRD below; it also lives in the repo as `docs/prd-vt-terminal.md` on the feature branch.

## Upstream requirements

Promotions of the escape hatches the renderer starts on — each filed from the §11 table below. Every hatch is confined behind the `RendererOps`/`keys.ts` seams and is deleted (with the matching lockfile bump) as its promotion lands:

- [ ] sidorares/ntk#252 — `Surface.copyWithin(rect, dx, dy)`: the scroll fast path, and the one that makes the retained renderer fully public-API
- [ ] sidorares/react-x11#283 — adopt ntk#252 through `react-x11/ntk`, retire the raw `X.CopyArea` hatch for custom elements
- [ ] sidorares/ntk#253 — `ctx.fillRects(rects)`: batched background fills, one `FillRectangles` per call
- [ ] sidorares/ntk#254 — `Font.glyphIdFor(codepoint)` + documented/frozen `drawGlyphs` run contract
- [ ] sidorares/react-x11#284 — `altKey` / `metaKey` on synthetic events

Backend parity, filed 2026-09-02 when react-x11 2.3.0's native macOS backend became the default on a Mac — the same seams, missing from a second engine rather than undocumented in the first. Landed in react-x11 2.4.0 (the seams) and 2.5.0 (the `Surface`); adopting them was the floor bump to `^2.5.0` and nothing in the renderer. `FontSet.glyphRuns` stays as the degrade path — an engine without the seams paints nothing, with a one-time development warning:

- [x] windowkit/appkit#1 — CoreText natives: glyph id for a codepoint, advances, a fallback face, `ctxDrawGlyphs`
- [x] sidorares/react-x11#432 — the Cocoa face grows `glyphIdFor`/`advanceOf`/`shape` and ntk's metric names, the manager `fallbackFor`, the ctx `drawGlyphs`/`createSolidPicture`/`Render.PictOp` (react-x11 2.4.0)
- [x] sidorares/react-x11#433 — an offscreen `Surface` on Cocoa through `react-x11/ntk`, for the retained renderer's scroll copy (react-x11 2.5.0)

None of them blocks **M1** (the DirectRenderer milestone is public-API-only by design); **M2** ships on the hatches and upgrades in place as these land.

---

**Prior decisions honored:** AGENTS.md "Running someone else's program" (all four rules), the reserved `write()` name, `TerminalProps` as the stable surface, tree-shaking constraints, `types: []` in the build.

Everything in this document that names a file and line was verified against the
**lockfile-pinned** toolchain: react-x11 `3b3691a` (master, self-reports 1.2.0)
and ntk **7.5.0**, plus `@xterm/headless` **6.0.0** typings. Where the claim is
about a dependency we do not control, the section says so.

---

## 1. Summary

`<Terminal backend="vt">` renders a real terminal without spawning an emulator:
a PTY (via a pluggable `PtyHost`, node-pty by default), `@xterm/headless` as the
escape-sequence-to-screen-state machine, and a cell-grid renderer built as a
registered react-x11 element that draws with XRender glyph runs into a retained
offscreen surface, scrolls with server-side `CopyArea`, and coalesces updates
onto react-x11's vblank-paced frame clock.

What it buys over the existing XEmbed backends:

- **Works with nothing installed** (modulo the PTY module — §6): the fallback
  the issue asked for.
- **`write()` becomes real.** The PTY is ours, so the reserved handle method
  lands, along with programmatic resize, selection access and serialization.
- **It is a native element, not a hole punched in the window.** Theme colors
  apply exactly, `<popup>` overlays work above it, focus/keyboard follow app
  rules, and the pane composites like any other node (the `<foreign>` child
  window always stacks above drawn content; this doesn't).
- **Testable in CI.** No `$DISPLAY`-with-xterm needed: a fake PTY plus the
  in-process X server give byte-in/pixel-out tests
  (`react-x11/testing` `pixelAt`/`getImageData`).

Non-goal up front: this does not replace the XEmbed backends. `backend="auto"`
keeps preferring a real emulator; `vt` is the always-available floor (§5.3).

---

## 2. Goals and non-goals

### Goals (P0/P1)

1. Full VT/xterm behavior for real workloads: shells, vim/htop (alt screen,
   cursor addressing), react-ink/claude-code style TUIs (bursty multi-line
   redraws), 256/truecolor, wide (CJK) cells, scrollback, resize with reflow.
2. Performance envelope (measured targets in §12):
   - echo latency: one frame; per-keystroke render cost microseconds, not
     milliseconds;
   - full-rate scrolling output (`yes`, `cat bigfile`, `find /`): frame-rate
     bounded, flow-controlled, UI never starved;
   - curses-style partial redraws touch only changed cells.
3. Grid selection (char/word/line), PRIMARY on select, middle-click paste,
   Ctrl+Shift+C/V, mouse reporting to apps that ask for it.
4. The component API is the **existing** `TerminalProps` + `TerminalHandle`,
   extended compatibly. An app that today renders `<Terminal>` gets the vt
   backend by changing (or omitting, once auto includes it) one prop.
5. Zero cost to non-users: lazy module graph, optional dependencies, no new
   hard deps, `sideEffects: false` intact.

### Non-goals (documented, some revisited later)

- Color emoji and image protocols (sixel, iTerm2, kitty graphics). ntk
  glyphsets are a8 alpha masks (`ntk/lib/text/glyphs.js` — a8 format only);
  images need an ARGB path. Future work; the renderer keeps a seam (§8).
- Font ligatures (Fira Code). Grid rendering bypasses shaping by design;
  same default as xterm.js.
- IME/preedit (XIM/ibus). react-x11 has **zero** IME support today (verified:
  no XIM/compose/preedit anywhere in the package) — a toolkit-level gap that
  a component cannot fix. Dead keys that ntk resolves to a `codepoint` work.
- Kitty keyboard protocol, extended underline colors (blocked on
  `@xterm/headless` public API — §10.4), reflow-free resize modes.
- Being a general xterm.js "renderer addon". The renderer is ours and speaks
  ntk; the emulator core is the dependency.

---

## 3. The user's design sketch, reviewed against verified facts

The issue sketch (grid + damage + mono runs + two colors + offscreen swap +
grid selection + frame sync) is essentially correct. Refinements, each carried
into the design:

| Sketch item                                                                              | Verdict                                                                                  | Refinement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Repaint just the damaged rectangle"                                                     | Yes, but track damage in **cells, derived by model diff**, not by parsing escape effects | Escape-level damage is fragile (one CSI can move the whole screen). Diffing the emulator's buffer against a mirror of what was last drawn is O(cols×rows) integer compares per frame (~2k for 80×24 — microseconds), catches _everything_ (selection, blink, palette swaps), and makes "eventually correct" a structural property rather than a discipline. See §7.3.                                                                                                                                     |
| "Screen moved one line up → copy undamaged area"                                         | Yes                                                                                      | Detect the shift from buffer coordinates (`viewportY`/`baseY` deltas), `CopyArea` the surviving band **within our retained surface**, then let the ordinary diff repaint what remains. One mechanism covers PTY scroll-out, `scrollLines()` viewport moves, and curses partial scrolls. §7.4.                                                                                                                                                                                                             |
| "Mono font, bypass shaping, render runs of glyphs"                                       | Yes — ntk has a raw door                                                                 | `ctx.drawGlyphs(op, srcPicture, positioned)` (`ntk/lib/renderingcontext_2d.js:1408`) accepts **synthetic runs** (`{font, size, glyphs:[{id, ax, dx, dy}]}`) — no shaping, one `CompositeGlyphs` request per draw, glyphs cached server-side per (face,size) with 1-byte ids. Break runs on fg color + font variant (bold/italic), exactly as sketched. §7.5.                                                                                                                                              |
| "Every cell is 2 colors max"                                                             | Mostly                                                                                   | bg + fg covers ~99%. Exceptions: (a) decorations — underline/strike currently render in fg; _colored/curly_ underline (SGR 58/4:3) is not exposed by `@xterm/headless` public cell API, so P2-blocked-upstream; (b) cursor and selection — implemented as **color transforms of the cell**, not extra layers, so the invariant survives; (c) wide glyphs paint one glyph across two cells' backgrounds. §7.2.                                                                                             |
| "Composite into offscreen picture, then swap; expose = copy backing buffer"              | Already half-built into the platform                                                     | ntk windows are **already** backing-store double-buffered with damage-rect presents (Present extension or CopyArea fallback), and **Expose never reaches JS** — ntk services it from the backing pixmap (`ntk/lib/window.js:908`). We still keep our **own** retained `Surface` for cell content (so react-x11 repaints of _other_ nodes never force us to re-render cells, and so scroll-copy has a stable source); the node's paint is then a single `drawImage` sub-rect blit = one `Composite`. §7.6. |
| "Selection simple because of the grid"                                                   | Yes                                                                                      | Grid coords + the mirror trick: selection state is an input to each cell's diff signature, so selection changes repaint exactly the cells whose highlight changed, through the same path as content changes. §9.                                                                                                                                                                                                                                                                                          |
| "Don't output each update instantly; follow frame sync; skipping OK; eventually correct" | Matches the platform exactly                                                             | `node.invalidate(rect)` → one scheduled `requestAnimationFrame` on ntk's frame clock (Present `CompleteNotify` vblank pacing, at most one frame in flight, measured `refreshInterval`). Intermediate states are never drawn because the renderer reads _the latest_ model at paint time; the mirror-diff guarantees convergence. Keystroke latency is covered by react-x11's discrete-event tier, which flushes a frame right after key handlers. §7.7.                                                   |

---

## 4. Where it lives, what it's made of

```
src/terminal/
  index.ts          — <Terminal> (exists) + backend='vt' branch, lazy import of ./vt
  backends.ts       — (exists, unchanged) external emulator argv table
  vt/
    index.ts        — registerElement('vtterm'), <VtSurface> internal component, JSX augmentation
    node.ts         — VtTermNode: the registered element (grid, input, selection, blink, renderer driving)
    renderer.ts     — RendererOps interface + RetainedRenderer (Surface+CopyArea) + DirectRenderer (plain ctx)
    diff.ts         — mirror grid, cell signatures, shift detection, dirty spans (pure, no X)
    keys.ts         — keysym+modifiers+modes → PTY bytes (pure table)
    mouse.ts        — pointer events + tracking mode → PTY bytes (pure table)
    colors.ts       — theme/props → 16+256 palette, solid-picture cache keys (pure)
    pty.ts          — PtyHost seam (structural types) + node-pty/@lydell probing impl
    xterm.ts        — structural types for the @xterm/headless slice we use (types only)
    fonts.ts        — mono font resolution, cell metrics, glyph cache (per char+variant → glyph id/run)
```

Division of labor (mirrors code-editor's node/component split and the embed
lifecycle):

- **The React component** (in `vt/index.ts`, used by `<Terminal>`): owns
  process things — resolve deps (dynamic imports), create `Terminal` (xterm)
  and PTY, wire data both ways with flow control, restart/exit/status, theme →
  palette resolution, imperative handle. All of it in effects; none of it in
  render.
- **The registered node** (`VtTermNode`): owns pixel and input things — cell
  metrics and yoga measure, the renderer and mirror, paint, cursor blink,
  selection, key/mouse encoding via the default-action seam, clipboard. It
  receives the live `term` object and callbacks (`onInput(bytes)`,
  `onGridResize(cols, rows)`) as props.

This keeps the node drivable by tests with a fake `term` and no PTY, and keeps
the component logic identical in shape to `useEmbeddedClient`.

**Registration and tree-shaking.** `src/terminal/index.ts` currently has _no
import-time side effects_ and must stay that way for XEmbed users; `vt/index.ts`
is the module with the `registerElement('vtterm', …)` side effect, loaded via
dynamic `import()` only when the vt backend is actually selected. The
treeshake guard gets a new entry asserting `@react-x11/components/terminal`
does not drag in `vt/` or `@xterm/headless`.

---

## 5. Public API

### 5.1 Props — `TerminalProps`, extended

Existing props keep their exact meaning: `command`, `cwd`, `env`, `fontFamily`,
`fontSize`, `scrollback`, `title`, `colors` (`TerminalColors` incl. `palette`),
`onExit`, `onTitleChange`, `onError`, `fallback`, `enabled`, `stopSignal`,
`focusable`, `style`, `ref`, `data-testname`.

Changes:

```ts
backend?: TerminalBackendName;          // now 'auto' | 'xterm' | 'urxvt' | 'alacritty' | 'vt'

/** vt only; ignored (with a DEV warning) by external backends. */
cursorStyle?: 'block' | 'underline' | 'bar';
cursorBlink?: boolean;                  // default true
onBell?: () => void;
bell?: 'none' | 'visual';               // default 'none'; 'visual' flashes the pane
allowClipboardWrite?: boolean;          // OSC 52 → CLIPBOARD; default true (read is never allowed)
onSelectionChange?: (text: string) => void;
/** The PTY seam, like `processes` is for the embed path. */
pty?: PtyHost;
```

Notes:

- `colors.palette` finally works fully (urxvt can't take one; we can). The
  default palette derives ANSI 0–15 from the theme the way the XEmbed path
  derives bg/fg/cursor today, with a fixed standard 16-color set where the
  theme has no answer, and the standard 6×6×6+grays cube for 16–255.
- `scrollback` maps to xterm's `scrollback` option (default 1000).
- `env` gets `TERM=xterm-256color` and `COLORTERM=truecolor` defaults (the
  emulator core is xterm-compatible; that's the honest advertisement).

### 5.2 Handle — `TerminalHandle`, extended

```ts
interface TerminalHandle {
  // existing
  restart(): void;
  signal(signal?: string): boolean;
  readonly pid: number | null;
  readonly windowId: number | null; // null for vt (no child X window)
  readonly backend: string | null; // 'vt' when active
  readonly status: EmbedStatus;

  // new; on external backends write() returns false and the rest are no-ops/null
  write(data: string): boolean; // → PTY. THE reserved method, real at last
  resizeToFit(): void; // re-derive cols/rows from layout now
  readonly cols: number | null;
  readonly rows: number | null;
  selection(): string | null;
  clearSelection(): void;
  scrollToBottom(): void;
  scrollLines(n: number): void;
  serialize(): string | null; // current screen as text (tests, "copy all")
}
```

`write()` on an external backend stays impossible for the documented reasons
(the pty belongs to xterm); returning `false` rather than throwing lets an app
feature-test with the call itself.

### 5.3 Backend resolution

`backend="auto"` order becomes: **xterm → urxvt → alacritty → vt**. Rationale:
external emulators are battle-tested and users who installed one expressed a
preference; `vt` is the floor that makes `fallback` almost never render. When
the vt backend has soaked, flipping it to the front is a one-line,
majorish-version decision — the PRD explicitly does not make it today.

`vt` availability probe = "can `PtyHost.openPty` be satisfied" (i.e. a PTY
module resolves) and `@xterm/headless` resolves. Failing that, status is
`'unavailable'` and `fallback` renders — never a throw (AGENTS.md rule).

### 5.4 Example (unchanged app code)

```jsx
<Terminal
  backend="vt"
  command={['bash', '-lc', 'npm test']}
  style={{ flexGrow: 1 }}
  onExit={({ code }) => setDone(code === 0)}
  onTitleChange={setTabLabel}
  fallback={<text>PTY support missing — npm i node-pty</text>}
/>
```

---

## 6. Dependencies

Verified facts (npm, 2026-08):

| package            | version    | unpacked                 | deps           | nature                                                      |
| ------------------ | ---------- | ------------------------ | -------------- | ----------------------------------------------------------- |
| `@xterm/headless`  | 6.0.0      | 1.96 MB                  | none           | pure JS state machine                                       |
| `node-pty`         | 1.1.0      | **64 MB**                | node-addon-api | native, prebuilds bundled for all platforms                 |
| `@lydell/node-pty` | 1.2.0-beta | 13.5 KB + 1 platform pkg | —              | fork; per-platform prebuilt optional deps (esbuild pattern) |

Policy (follows the repo's own precedents — `ical.js` optionalDependency,
`@lezer/highlight` optional peer):

- **`@xterm/headless` → `optionalDependencies`.** Installs by default (nothing
  else would bring it; the terminal is a flagship), allowed to be absent →
  `'unavailable'`. Loaded with dynamic `import()`; its API is consumed through
  **structural types written in `vt/xterm.ts`** (~150 lines for the slice we
  use), never `import type` from the package — same reason as `ical.ts`: an
  app that skipped optional deps must still type-check.
- **PTY → optional _peer_ dependencies, both `node-pty` and
  `@lydell/node-pty`,** probed in that order at runtime. Neither
  auto-installs: 64 MB (node-pty) would burden every consumer of this package
  — it alone exceeds react-x11's entire 41.6 MB closure that issue #7's
  measurements fight for — and native postinstalls fail on enough machines
  that forcing one is hostile. `peerDependenciesMeta.optional` keeps both bare
  specifiers resolvable under pnpm strict layout (the `@lezer/highlight`
  precedent). The docs and the `fallback` message carry the install line.
- **`PtyHost` is a public seam** (the `ProcessHost` argument, verbatim): "run
  the shell in a container / over ssh / in a sandbox" is real, and it is how
  tests drive the component. Sketch:

```ts
interface PtySession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): boolean;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (info: ExitInfo) => void): void; // ExitInfo from ../embed
  pause?(): void; // flow control, optional
  resume?(): void;
  readonly pid: number | null;
}
interface PtyHost {
  available(): Promise<boolean>;
  openPty(
    argv: readonly string[],
    opts: {
      cols: number;
      rows: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    },
  ): Promise<PtySession>;
}
```

`@xterm/headless` API we rely on — all verified public in the 6.0.0 typings:
`write(data, cb)`, `resize`, `reset`, `input`, `dispose`; `buffer.active` with
`type`, `cursorX/Y`, `viewportY`, `baseY`, `length`, `getLine(y)` →
`getCell(x, reusableCell)` (explicit reuse support for the diff loop), cell
attr/color accessors incl. `getFgColorMode()` docs blessing them for equality
checks, `isUnderline(): number` (carries the style variant); events `onData`
(terminal→host replies: DA, DSR, etc. — must be piped to the PTY), `onBell`,
`onTitleChange`, `onResize`, `onScroll`, `onLineFeed`, `onWriteParsed`;
`scrollLines/scrollToBottom/…`; `modes` (public: `applicationCursorKeysMode`,
`applicationKeypadMode`, `bracketedPasteMode`, `mouseTrackingMode:
'none'|'x10'|'vt200'|'drag'|'any'`, `sendFocusMode`, `originMode`, …);
`parser.registerCsiHandler/registerOscHandler`; `options` (setter):
`scrollback`, `cursorStyle`, `cursorBlink`, `drawBoldTextInBrightColors`,
`minimumContrastRatio`, `windowOptions`.

What the public API does **not** give us (checked): underline color/style
beyond the `isUnderline()` number, per-row change events (no `onRender` in
headless), mouse-encoding mode (SGR/UTF8/urxvt — only the _tracking_ mode is
in `modes`). Consequences in §7.3 (diff instead of change events), §10.3
(track encoding via a CSI observer), §10.4 (underline color deferred).

---

## 7. The renderer

### 7.1 Platform inventory it stands on (verified)

From react-x11 (`node_modules/react-x11/src`, pinned master):

- Custom elements: `registerElement(name, {create, drawn, semanticNames,
childrenAllowed})` (`registry.js`); node subclass gets `this.app` (ntk App:
  `.X` raw connection, `.fonts`, `.clipboard`), `this.root` (WindowNode) and
  `this.root.window` (ntk Window), `measureContent()` seam, `applyProps`,
  `destroySubtree`, `_paintContent(ctx)`/`paint(ctx)`, default-action seam
  (`defaultKeyDown/MouseDown/MouseDrag/MouseUp/Focus/Blur`),
  `focusableByDefault`, `defaultCursor`. Precedent: this repo's
  `CodeEditorNode`.
- Damage model: `node.invalidate(false, rectOrNode, reason)` forwards to the
  window collector (`nodes.js:2264`); damage is a **disjoint list capped at
  `MAX_DAMAGE_RECTS = 4`** (`nodes.js:312`), merged by least-waste beyond
  that; painting culls whole subtrees outside damage before any X request is
  emitted, and clips to the damage rect. Reasons are a closed DEV-checked
  set — `'text'`, `'scroll'`, `'caret'` fit us.
- Frame clock: first `invalidate` schedules one
  `window.requestAnimationFrame(flush)`; further invalidations coalesce
  (`_scheduled` gate). ntk's clock allows **one frame in flight**, paced by
  Present `CompleteNotify` (vblank) or a round-trip fence; `refreshInterval`
  is measured. Key events run in a _discrete_ tier that flushes pending
  frames immediately after handlers → keystroke echo does not wait for the
  next tick.
- Expose: serviced by ntk from the window backing store, JS never runs
  (`ntk/lib/window.js:908`); a real redraw arrives only as a synthetic
  full-window `'draw'` (first paint, resize, invalidation).

From ntk 7.5 (`node_modules/ntk/lib`):

- `Surface(app, {width, height, format: 'argb32'|'a8'})` — offscreen
  pixmap+picture with its own 2d context (`surface.js`); public export.
- `dstCtx.drawImage(surface, sx, sy, sw, sh, dx, dy, dw, dh)` — **one**
  server-side `Render.Composite` when unscaled, untransformed, rect-clipped
  (`renderingcontext_2d.js:3035`, direct path `~:2829`).
- `ctx.drawGlyphs(op, srcPicture, positioned)` — raw glyph-run submission
  (`renderingcontext_2d.js:1408`); glyphsets per (face,size) cached app-wide,
  1-byte glyph encoding, positions emitted only on pen deviation, LRU 8 MiB
  (`text/glyphs.js`). Under a **rectangular** clip: `SetPictureClipRectangles`
  fast path. Non-rectangular clips trigger a mask round-trip — never do that.
- Fonts: `app.fonts.match(family, {weight, style})` → `Font`;
  `font.metrics(size)` (ascent/descent/lineGap…), `font.advanceOf(gid, size)`,
  `font.hasGlyph(cp)`, `font.shape(text, size, …)` for the rare complex
  cluster; `app.fonts.fallbackFor(cp, family)` per-codepoint fallback;
  fontconfig matching via `fc-match` with charset filtering. **No synthetic
  bold/oblique** — a family without a bold face renders regular (P2:
  overstrike emulation).
- Solid color sources: `app.solidPicture(r,g,b,a)` / `ctx.createSolidPicture`
  — memoized per connection, `CreateSolidFill` on modern servers; `fillStyle`
  accepts a `Picture` directly, skipping CSS parsing per op.
- Scrolling: `Window.scrollRegion(rect, dx, dy)` — overlapping self-`CopyArea`
  inside the window backing store (`window.js:996`). **No equivalent on
  `Surface`/pixmaps** — §11 escape hatch #1.
- No batched fill-rectangles on the context (`Render.FillRectangles` is used
  internally only) — §11 escape hatch #2. No wcwidth/EastAsian logic anywhere
  (fine — xterm's buffer already assigns cell widths). Glyphsets are a8: no
  color emoji.

### 7.2 Cell model

A render cell = `(chars, width, fgColor, bgColor, flags)` where flags =
bold, dim, italic, underline(style), strikethrough, overline, inverse,
invisible, blink. Resolution to _paint_ colors happens in one pure function:

```
resolve(cell, state) -> { bg: PaletteEntry, fg: PaletteEntry, deco: DecoFlags }
  inverse       → swap fg/bg
  invisible     → fg = bg
  bold+palette<8 & drawBoldTextInBrightColors → fg index += 8
  dim           → fg = mix(fg, bg, 0.5)          (computed once per palette pair, cached)
  selected      → bg = selectionBg, fg = selectionFg (or reverse-video style)
  cursor cell (block, focused, blink-on) → swap/override with cursorBg/cursorFg
  minimumContrastRatio (P2) → nudge fg
```

So "2 colors per cell" holds _after resolution_, which is the property the
renderer exploits: **background pass = rectangles grouped by bg; foreground
pass = glyph runs grouped by (fg × font-variant); decoration pass = thin
rectangles in fg.** Cursor `bar`/`underline` shapes draw as fg-colored rects
on top; only `block` recolors the cell. Wide cells: one glyph at the left
cell's origin, both cells share one bg rect; the trailing placeholder cell
(width 0) is skipped by both passes but _included in signatures_ so damage
stays honest.

Blink (SGR 5): P2, implemented as a slow (~800ms) timer that toggles a global
phase bit included in blinking cells' signatures — no per-cell timers. Ships
off by default (`option`), like most modern terminals.

### 7.3 Damage: the mirror diff

The renderer never asks "what did that escape sequence touch?". It keeps a
**mirror** of what the retained surface currently shows:

```
mirror: {
  cols, rows,
  cellSig:  Uint32Array(cols*rows)   // FNV-mixed signature of resolved cell
  rowSig:   Uint32Array(rows)        // mix of the row's cellSigs
  absTop:   number                   // buffer-absolute index of mirror row 0
  bufferType: 'normal' | 'alternate'
  cursor: {x, y, style, on}
}
```

Per frame (inside paint, §7.7):

1. Read the viewport window from the term buffer: rows
   `[viewportY, viewportY+rows)`, reusing one work-cell object
   (`getCell(x, cell)` — the API is designed for this; zero allocation).
2. **Shift detection** (§7.4). Maybe issue one `CopyArea`; adjust mirror.
3. For each row: recompute row signature; if equal to mirror's, skip (cost:
   cols signature mixes ≈ tens of ns/row). Else walk cells, collect **dirty
   spans** (runs of changed cells, bridging gaps ≤ 2 cells to avoid
   fragmenting draw calls), update mirror entries.
4. Emit draw ops for dirty spans into the retained surface (§7.5, §7.6).
5. Blit the union of dirty pixel rects from surface → window ctx, batched to
   **≤ 4 bands** (the `MAX_DAMAGE_RECTS` cap means more would be merged
   upstream anyway; we pre-merge on row adjacency).

Why diff instead of xterm's events: headless exposes no per-row damage
(`onRender` is a browser-renderer thing), and event-derived damage can't see
selection/cursor/palette-induced changes. The mirror makes every state input
(selection range, cursor pos/phase, palette generation, blink phase) part of
the signature, so _one_ mechanism repaints exactly what changed, whatever the
cause — and if a frame is skipped entirely, the next diff repairs the screen:
**eventual correctness is structural.**

Cost envelope: signatures for 240×67 ≈ 16k cells ≈ 0.2–0.5 ms worst case
(every row dirty); typical typing frame touches 1–2 rows ≈ single-digit µs.

### 7.4 Scroll fast path

Before row diffs, compare the buffer's window origin against the mirror:

```
shift = (buffer.viewportY) - mirror.absTop        // >0: content moved up
if bufferType changed or |shift| >= rows → full dirty, no copy
else if shift ≠ 0:
    CopyArea(surface, surface, gc,
             0, shift*cellH, 0, 0? …)             // surviving band, one request
    memmove mirror.cellSig/rowSig by shift rows
    mark the shift-exposed edge rows dirty
    mirror.absTop = buffer.viewportY
```

This covers: shell scroll-out (`baseY`/`viewportY` advance together when
following the bottom), user scrollback paging (`scrollLines` changes
`viewportY` only), and `vim`'s partial scroll-region moves _fall out
naturally_ — the region CopyArea won't match those, but the row diff after a
scroll-region operation only finds the actually-moved rows changed, which is
still minimal work. (A per-scroll-region copy optimization is deliberately
out: detecting it from buffer state is guesswork; the diff already bounds the
cost to the moved band's glyph redraw.)

The copy is **within our retained Surface** — `ntk` has no wrapper for
pixmap self-copy, so this is raw `app.X.CopyArea(pix, pix, gc, …)` with our
own `graphicsExposures: 0` GC — escape hatch #1, promotion proposed (§11).
Overlapping self-copy on a pixmap is well-defined (contents can't be
occluded), which is exactly why the backing store, not the window, is the
right copy source.

`Window.scrollRegion` (public) was considered instead of an own Surface: it
operates on the _window's_ backing store, which react-x11 also paints other
nodes into; correctness would then depend on nothing overlapping the band
mid-frame and on react-x11's damage bookkeeping not repainting our rect
after we shifted it. The retained Surface decouples us from all of that for
the price of one extra composite per frame (batched with everything else in
the frame's single socket flush — measured in §12 anyway).

### 7.5 Foreground: glyph runs

Per dirty span, group consecutive cells by `(fg, variant)` where variant ∈
{regular, bold, italic, boldItalic} maps to a `Font` resolved once per
(family, size) via `app.fonts.match` (missing faces degrade to regular). Emit
one `positioned` entry per group; **one `ctx.drawGlyphs` call per span**
submits all groups sharing a glyphset in a single `CompositeGlyphs` request.

Glyph lookup is a cache `charKey(chars, variant) → {gid, font} | ShapedRun`:

- single BMP codepoint, `font.hasGlyph(cp)` → `gid = glyphForCodePoint(cp)`
  (fontkit via `font.fk` — escape hatch #3v, see §11), advance ignored —
  **positions are grid-computed**: `x = col*cellW`, per-glyph explicit, so
  fractional font advances can never accumulate drift (the run encoder emits
  a position delta only when the pen deviates — cost only when it matters).
- codepoint missing from the mono font → `app.fonts.fallbackFor(cp)`; run
  breaks (different glyphset), still batched in the same draw call.
- multi-codepoint cluster (combining marks, VS16 text-presentation emoji) →
  shape the cluster once via `font.shape(chars, …)`, cache the tiny run,
  stamp it at the cell origin. Rare path, bounded cache.
- box-drawing and block elements U+2500–259F: **P2** — procedural rectangles
  instead of font glyphs (pixel-perfect joins, like every serious terminal);
  until then they render as font glyphs.

Decorations (underline/strike/overline) are fg-colored 1px rects per span,
drawn after glyphs; underline style variants beyond single: P2 (see §10.4).

### 7.6 Background and the blit

Backgrounds per dirty span: consecutive same-bg cells merge into one rect.
Default-bg cells still paint (the surface must be self-contained for the
blit and for scroll-copy). Today that is N `fillRect` = N `Composite`
requests per distinct rect — fine for typing, measurable for full-screen
redraws; escape hatch #2 batches a whole frame's rects per color into one
`Render.FillRectangles(PictOp.Src, …)` — proposed for promotion (§11).

Blit: in `_paintContent(ctx)`, `ctx.drawImage(surface, band…)` per dirty
band (≤4), one `Composite` each. When react-x11 calls paint for reasons that
aren't ours (ancestor repaint overlapping us, theme flip), the diff finds
nothing dirty and the blit re-copies the requested region only — the surface
_is_ our answer to "redraw yourself" and no cell work happens.

The node's own `style.backgroundColor` defaults to the terminal bg color, so
padding/borders behave like every other element; the surface covers only the
cell grid (content box, minus the partial-cell remainder gutters).

### 7.7 Scheduling: who calls whom

```
pty.onData(chunk) ──► term.write(chunk, cb)     [xterm queues internally]
                      bytes += chunk.length; if bytes > 512K → pty.pause()
                      cb: bytes -= chunk.length; if bytes < 128K → pty.resume()
term.onWriteParsed / onScroll / onTitleChange …
        └──► node.modelDirty()  ──► this.invalidate(false, gridRect, 'text')
                                    (constant-time; coalesced by _scheduled gate)
frame (rAF on ntk clock, or discrete flush after a key event)
        └──► node._paintContent(ctx):
                 diff → CopyArea? → surface updates → blit bands
```

Properties that fall out, matching the sketch's requirements:

- **Coalescing**: any number of PTY chunks between frames = one diff+paint.
  A `yes(1)` firehose becomes ~refresh-rate frames, each: 1 CopyArea + ≤rows
  row-renders + ≤4 blits. Intermediate screens are simply never materialized.
- **Latency**: keystroke → handler writes to PTY; echo comes back on the
  next data event; `invalidate` inside a discrete key event flushes
  immediately after handlers if no frame is in flight (react-x11's discrete
  tier) — worst case one vblank.
- **Flow control**: watermarks above; if the `PtySession` lacks
  `pause/resume`, xterm's internal write queue still bounds _parse_ work per
  tick and memory grows only with the outstanding pipe content — documented
  degradation, node-pty has pause/resume.
- **Never block the loop**: term.write chunks are already sliced by xterm's
  write buffer; the diff is bounded by the grid size, not by input volume.

One subtlety: `invalidate` damage passes the **grid rect**, but the actual
dirty band isn't known until the diff runs inside paint. Passing the full
grid rect as damage is correct (it's a clip + cull bound, not a promise to
redraw everything) — but it forfeits react-x11's ability to skip _sibling_
repaints... it does not: damage only selects which nodes repaint; our own
paint then blits only what the diff dirtied. The alternative — running the
diff eagerly at invalidate time to claim precise rects — buys tighter
sibling culling in exchange for diffing off the frame clock. **Decision:
claim the grid rect (simple, correct); revisit only if profiling shows
sibling overdraw mattering** (terminals rarely have overlapping siblings).

### 7.8 The three scenarios, end to end

**Typing one char at the prompt** (echo `a`):
diff: prompt row signature differs → span of 1–2 cells (char + cursor cell)
→ ops: 1 bg rect, 1 glyph run (1 glyph), cursor rect/glyph, 1 blit band ≈
**≤ 5 render requests**, single-digit µs of JS, painted in the discrete
flush right after the data event's frame is scheduled.

**Whole terminal scrolls by one line** (shell output):
shift = 1 → 1 `CopyArea` (surface self-copy) + bottom row renders (1–3 bg
rects, 1–4 glyph runs) + cursor + 1–2 blit bands. Mirror memmove. **O(1) in
screen height for the copy; O(cols) for the new row.** At 10k lines/sec the
frame clock samples it at refresh rate: each frame shift=N collapses to one
CopyArea (N<rows) or full-repaint (N≥rows — cheaper than N copies anyway).

**Curses/react-ink burst** (htop tick, claude-code spinner+lines):
no shift; row signatures localize change to k rows; each dirty row renders
as spans (typically the changed columns only, since curses apps
cursor-address minimal updates _and_ our diff re-derives minimality even
when they redraw whole lines with identical content — identical signature =
skip). Cost ∝ actually-changed cells, ≤ 2 ms at full-screen 240×67 churn.

### 7.9 Resize

Layout gives the node a new content box → `cols = floor(w/cellW)`,
`rows = floor(h/cellH)`; if changed: `term.resize(cols, rows)` (xterm
reflows wrapped lines itself), `pty.resize` (SIGWINCH), surface realloc
(grow-only with 25% headroom, like ntk's backing store), full-dirty mirror.
Font-size/family prop change: recompute metrics, drop glyph caches, same
path. `measureContent` reports preferred size = 80×24 cells so a bare
`<Terminal>` in a dialog has a sane intrinsic size; flex owns the rest.

---

## 8. Renderer abstraction

```ts
interface RendererOps {
  begin(frame: FrameInfo): void;
  copyRows(srcRow: number, dstRow: number, count: number): boolean; // false: unsupported
  fillCells(row: number, col: number, count: number, bg: ResolvedColor): void;
  drawRun(row: number, col: number, run: GlyphRun, fg: ResolvedColor): void;
  decorate(
    row: number,
    col: number,
    count: number,
    deco: Deco,
    fg: ResolvedColor,
  ): void;
  end(): DirtyBands;
}
```

- **`RetainedRenderer`** (default): ntk Surface + raw CopyArea + drawGlyphs +
  (later) FillRectangles batching. Probes its needs at construction
  (`typeof app.X?.CopyArea === 'function'`, surface creation succeeds); any
  probe failure falls back to…
- **`DirectRenderer`**: public-API-only — no surface, no copy (`copyRows`
  returns false → caller full-dirties moved rows), draws with `fillRect` +
  `drawGlyphs` (or `fillText` at worst) straight into the paint ctx each
  frame. Slower on scroll, identical pixels. It is also the **correctness
  reference** in tests (same byte stream → same cell decisions → compare op
  streams), and the mock-backend path (mock ctx has no pixel API at all —
  paint degrades to a no-op, per repo convention).

This seam is what keeps every escape hatch optional, testable, and cheap to
delete as upstream APIs land.

---

## 9. Selection and clipboard

- Grid selection in buffer-absolute coords `{startLine, startCol, endLine,
endCol}` so scrollback selection survives scrolling. Char drag; word on
  double-click (`detail: 2` — react-x11 supplies click counts) with a
  `wordChars` default of `/[[:alnum:]_\-./~]/`-ish; line on triple.
  Auto-scroll while dragging beyond edges.
- Rendering: a pure predicate `inSelection(absLine, col)` feeds the cell
  signature — selection changes repaint exactly the boundary-delta cells via
  the ordinary diff. Zero dedicated paint code beyond the color transform.
- **PRIMARY on selection end** (X convention), middle-click pastes PRIMARY
  (`button 2`, like `TextInputNode` and `CodeEditorNode`), Ctrl+Shift+C/V for
  CLIPBOARD, right-click menu deferred (P2, `<popup>` composition). All
  through `app.clipboard.write/read({selection})` — public, ICCCM timestamps
  handled by react-x11's input-time plumbing.
- Extraction: `line.translateToString(true /*trimRight*/)` per line, joining
  with `\n` except across `isWrapped` continuations — reflow-true copy.
- Keyboard input, PTY output, or `clear` **collapse the selection** (standard
  behavior; keeps the "selection is part of signatures" model cheap).
- OSC 52: app-initiated clipboard **write** honored when
  `allowClipboardWrite` (default true), capped at 1 MB, CLIPBOARD only;
  **read requests answered with an empty reply always** (never expose
  clipboard contents to the PTY — kitty/iTerm default posture).

---

## 10. Input

### 10.1 Keyboard → bytes (`keys.ts`, pure)

Inputs per key event: `keysym` (unshifted, group-1), `codepoint` (composed,
level-aware — dead keys already resolved by ntk), `shiftKey`, `ctrlKey`, and
**Alt/Meta read from `ev.nativeEvent.buttons & 8 / & 64`** — the synthetic
event does not carry them (escape hatch #4; promotion proposed).

Encoding rules (xterm-compatible; table-driven, exhaustively unit-tested):
printable codepoint → UTF-8, `Alt` prefixes ESC; `Ctrl+@..._` → C0 via the
standard mapping (`ctrl+a` = 0x01, `ctrl+space` = NUL, …); arrows/Home/End
`CSI`/`SS3` per `applicationCursorKeysMode`; keypad per
`applicationKeypadMode`; F1–F12(+mods) per xterm's CSI/SS3 tables with the
`;modifier` parameter scheme; Backspace → DEL (0x7f), Delete → `CSI 3~`,
PgUp/PgDn `CSI 5~/6~` (+mods); Enter → CR; Shift+Tab → `CSI Z`. The keysym
constants beyond react-x11's exported set (keypad, F-keys exist; misc gaps)
live in a local table — keysyms are stable numbers.

Paste (`Ctrl+Shift+V` / middle-click): bracketed when
`modes.bracketedPasteMode` (`ESC[200~ … ESC[201~`, with `\r`-normalized
newlines and C0-stripped content), raw otherwise.

**Tab and focus.** Core cycles focus on Tab before default actions
(`events.js:872`) unless a handler prevents it. The component installs the
same bargain the code editor documents (docs/extending.md convention):
consume Tab (preventDefault + encode to PTY) normally; **Escape arms one
pass-through Tab** — with the terminal-specific twist that Escape itself is
_also_ still sent to the PTY (arming is a side effect, not a swallow), and
arming is **disabled while the alternate screen is active** (a full-screen
vim owns Esc-then-Tab as real input; a focus-trapped full-screen app is the
expected UX, and the pointer or a chord still leaves). Open question §15
records the alternative (a dedicated leave chord like Ctrl+Shift+Tab).

Everything not consumed (app chords, unhandled keys) is left alone: user
`onKeyDown` handlers already ran first — the default-action seam guarantees
an app-level shortcut beats the terminal, same as the XEmbed path documents.

### 10.2 Focus reporting

`modes.sendFocusMode` → `CSI I`/`CSI O` on `defaultFocus`/`defaultBlur`.
Cursor renders hollow/dim when unfocused (classic), blink timer only runs
focused (CARET_BLINK-style interval + `invalidate(cursorRect, 'caret')`).

### 10.3 Mouse reporting (`mouse.ts`, pure)

Gate: `modes.mouseTrackingMode !== 'none'` **and** Shift not held (Shift
reserves the gesture for selection — universal escape). Tracking mode from
public `modes`; **encoding** (SGR 1006 / urxvt 1015 / UTF-8 1005) is not
exposed, so a passive `parser.registerCsiHandler({prefix:'?', final:'h'/'l'})`
observer records DECSET/DECRST of 1005/1006/1015/1004/1007 and **returns
false** so xterm still processes them — public parser API used as designed,
but flagged (§11 #6) as coupling to sequence-level behavior. Encode press/
release/drag/wheel per mode; X10 clamps >223 coords; wheel in alt-screen
without tracking honors `alternateScrollMode` (DECSET 1007) → arrow keys ×3.

### 10.4 Blocked upstream (recorded, not worked around)

- Colored/styled underlines: `IBufferCell` exposes `isUnderline(): number`
  (style) but no underline **color**; reaching into `_core` is rejected.
  File upstream; render single underline in fg meanwhile. (P2)
- No public "rows changed" event in headless — the mirror diff makes this a
  non-issue for us (deliberate architecture, not a workaround).

---

## 11. Escape hatches and proposed public APIs — the promotion table

The component's performance envelope justifies escape hatches (per review
direction); each is isolated behind `RendererOps`/`keys.ts`, probed before
use, and listed here with its upstream disposition. "Promote" means: propose
as public API in the named package; adopting it later means an explicit
lockfile bump of the git-pinned dep (known trap: without the bump local
installs pass and every CI job fails — do the bump in the same PR).

| #   | Need                                                          | Today                                                                                                                                                                      | Escape hatch used                                                                                                                                             | Promote?                                                                                                                                                                                                                                  | Proposed API                                                                                                                 |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scroll: overlapping self-copy **within an offscreen Surface** | `Window.scrollRegion` exists for the _window_ backing only (`ntk window.js:996`); nothing for `Surface`/`Pixmap`                                                           | `app.X.CopyArea(pix, pix, ownGC, …)` + own `CreateGC(graphicsExposures: 0)`                                                                                   | **Yes — ntk.** Highest value: it makes the whole retained renderer public-API. Filed: [ntk#252](https://github.com/sidorares/ntk/issues/252), adoption tracked in [react-x11#283](https://github.com/sidorares/react-x11/issues/283)      | `Surface.copyWithin(src: Rect, dx, dy)` — same semantics/doc as `scrollRegion`, minus damage bookkeeping (pixmaps have none) |
| 2   | Batched background fills (one request per color for N rects)  | ctx has only per-rect `fillRect` = N `Composite`s; `Render.FillRectangles` used internally only                                                                            | `ctx.Render.FillRectangles(PictOp.Src, ctx.picture.id, rgba, rects)` (+ manual `window._markDirty` when targeting the window ctx — not needed on our Surface) | **Yes — ntk.** Generally useful (tables, heatmaps, any cell grid). Filed: [ntk#253](https://github.com/sidorares/ntk/issues/253)                                                                                                          | `ctx.fillRects(rects: Rect[])` honoring current `fillStyle`/clip; batches per call                                           |
| 3   | Glyph runs without shaping, grid-positioned                   | `ctx.drawGlyphs(op, src, positioned)` exists and `fillText` is built on it, but the `positioned`/run shape (`{font,size,glyphs:[{id,ax,dx,dy}]}`) is undocumented contract | Synthetic run objects; solid `Picture` per fg color via `ctx.createSolidPicture`                                                                              | **Yes — ntk, as documentation/freeze** rather than new surface: bless the run shape + `drawGlyphs` as public, or add a narrower `ctx.fillGlyphRun(font, size, ids, xs, y)`. Filed: [ntk#254](https://github.com/sidorares/ntk/issues/254) | Document + type it; semver-guard the shape                                                                                   |
| 3v  | Glyph id for a codepoint without shaping                      | Only `font.fk.glyphForCodePoint(cp)` (fontkit internal reach-through); `font.hasGlyph` is public                                                                           | `font.fk.glyphForCodePoint(cp).id`                                                                                                                            | **Yes — ntk, trivial.** Filed with #3: [ntk#254](https://github.com/sidorares/ntk/issues/254)                                                                                                                                             | `Font.glyphIdFor(codepoint): number \| null`                                                                                 |
| 4   | Alt/Meta modifiers on key events                              | Synthetic event has only `shiftKey`/`ctrlKey` (`events.js`); `MOD1_MASK` defined but unexposed                                                                             | `ev.nativeEvent.buttons & 8` (Alt), `& 64` (Super)                                                                                                            | **Yes — react-x11, trivial and universally wanted** (any app with Alt chords). Filed: [react-x11#284](https://github.com/sidorares/react-x11/issues/284)                                                                                  | `altKey`, `metaKey` on `KeyboardEvent`/`MouseEvent`                                                                          |
| 5   | Damage rects: ≤4 per window, merged beyond                    | `MAX_DAMAGE_RECTS = 4` (`nodes.js:312`)                                                                                                                                    | None — we pre-batch dirty rows into ≤4 bands ourselves                                                                                                        | **No.** The cap is a sane wire-amplification guard; band-batching is the correct client behavior anyway                                                                                                                                   | —                                                                                                                            |
| 6   | Mouse _encoding_ mode (SGR/…) knowledge                       | `@xterm/headless` `modes` exposes tracking mode only                                                                                                                       | Passive `registerCsiHandler` observer on DECSET/DECRST (public API, but sequence-coupled)                                                                     | **Yes — xterm.js**, file: expose `mouseEncoding` alongside `mouseTrackingMode` in `IModes`                                                                                                                                                | upstream issue                                                                                                               |
| 7   | Keypad/F-key keysym constants                                 | `react-x11/keysyms` covers common + F-keys; keypad set sparse                                                                                                              | Local constant table (keysyms are stable numbers)                                                                                                             | **Nice-to-have — react-x11**; zero-risk additions                                                                                                                                                                                         | extend `keysyms.js`                                                                                                          |
| 8   | Underline color/style per cell                                | Not in `@xterm/headless` public `IBufferCell`                                                                                                                              | None — feature deferred (P2) rather than reaching into `_core`                                                                                                | **Yes — xterm.js** feature request                                                                                                                                                                                                        | upstream issue                                                                                                               |

Explicitly rejected escape hatches: reaching into `term._core` (xterm.js
internals churn hard between majors); `Window.scrollRegion` on the shared
window backing as our scroll mechanism (fights react-x11's own bookkeeping —
§7.4); private react-x11 fields (`_paintDamage` etc. — everything we need is
reachable through `Node`'s protected surface and `this.app`).

---

## 12. Performance targets and instrumentation

Measured on the dev machine class the issue thread uses (`NODE_ENV=production`,
local X):

| Scenario                            | Target                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keystroke echo (80×24, prompt)      | ≤ 1 frame added latency; ≤ 50 µs JS render cost; ≤ 8 render requests                                                                                                           |
| Scroll-out, one line                | 1 CopyArea + one row of draws; ≤ 300 µs JS                                                                                                                                     |
| `yes` / `cat` firehose              | frame-rate-bounded; ≥ 40 MB/s sustained parse (xterm-bound); RSS growth bounded by watermarks (≤ 8 MB buffered); zero missed-then-wrong frames (eventual correctness asserted) |
| htop full redraw @ 240×67           | ≤ 2 ms JS per frame                                                                                                                                                            |
| Full-screen dirty diff (worst case) | ≤ 1 ms signatures @ 240×67                                                                                                                                                     |
| Memory                              | mirror ≤ 256 KB @ 240×67; Surface = grid px × 4 server-side; glyph caches under ntk's 8 MiB LRU; scrollback = xterm's (~1–2 MB @ 1000 lines)                                   |

Instrumentation: react-x11's `startTrace()`/`REACT_X11_TRACE` frame hooks
(rects, reasons, landed latency) plus a `vt/bench.ts` script replaying
recorded byte fixtures (vim session, htop, react-ink burst, `cat` of a large
file, vtebench selections) against a real and a fake clock, reporting
frames, requests/frame (from a `RendererOps` counting decorator), and JS
ms/frame. Draw-op budgets are **asserted in tests** (the counting spy), so
"typing repaints one cell" is a regression guard, not a hope.

---

## 13. Testing

- **Pure units** (no X): `keys.ts` (golden byte tables across all mode
  combinations), `mouse.ts`, `colors.ts`, `diff.ts` (feed synthetic grids →
  assert spans/copies — including the scroll+edit-same-frame and
  alt-screen-switch cases), selection extraction (wrapped lines, wide chars,
  trailing spaces).
- **Node-level, mock backend**: mount `<Terminal backend="vt">` with a
  `FakePtyHost` + real `@xterm/headless`; feed fixture bytes; assert screen
  text via `serialize()`, cursor, title events, exit/restart lifecycle, flow
  control (pause called past watermark). Mock ctx ⇒ paint no-ops (repo
  convention) while layout/measure still assert cols/rows.
- **Renderer op tests**: `DirectRenderer` vs `RetainedRenderer` behind the
  counting spy — identical cell decisions, budget assertions per scenario
  (§12 table).
- **Pixel tests** (in-process JS X server, `react-x11/testing` `pixelAt`):
  colors land (bg/fg/palette/truecolor), cursor block inverts, selection
  highlights, scroll preserves band content (the CopyArea path really
  copied), expose repaints from backing (kill damage, re-present, compare).
- **Type tests** (`test/types/terminal.tsx`): props/handle compat — the
  "change one prop" ladder promise, `write()` on the unified handle.
- **treeshake guard entry**: importing the barrel or `./terminal` without
  using vt pulls none of `vt/` or `@xterm/headless`.
- CI needs no PTY: `FakePtyHost` everywhere; one opt-in local test
  (`REACT_X11_COMPONENTS_REAL_PTY=1`) runs a real `sh -c` echo through
  node-pty when present.

---

## 14. Milestones

**M0 — spike (throwaway, ~2–3 days).** Registered node + Surface + drawGlyphs

- raw CopyArea rendering a hardcoded grid inside `examples/`; verify the
  escape hatches behave on a real server (and capture request counts via
  trace). Confirms §11 rows 1–3 before anything depends on them.

**M1 — correct terminal (P0).** `backend="vt"` end-to-end: PtyHost +
node-pty probing, xterm wiring (data both ways, title, bell, resize,
modes), **DirectRenderer** only, full keyboard encoder, theme colors +
palette, cursor (blink, styles, focus hollow), wheel scrollback +
scroll-to-bottom-on-input, `write()`/handle, exit/restart/fallback, mock +
unit + pixel tests, example. _Ship bar: daily-driveable shell + vim + htop,
correct if not yet optimal._

**M2 — fast terminal (P1).** RetainedRenderer: mirror diff, dirty spans,
scroll CopyArea, blit bands, draw-op budget tests, bench script + targets
(§12), glyph/cluster caches, selection + PRIMARY/CLIPBOARD + middle paste +
Ctrl+Shift+C/V, minimal scrollbar thumb. `auto` ladder gains vt as floor.

**M3 — complete terminal (P2).** Mouse reporting, bracketed-paste hardening,
OSC 52 (write-only, gated), visual bell, blink attribute (global phase),
box-drawing procedural glyphs, bold-overstrike fallback, dim/contrast
polish, right-click menu via `<popup>`, docs.

**M4 — future (P3 / upstream-gated).** Colored underlines (xterm.js),
URL detection + OSC 8 hover/activate, search over scrollback, sixel/kitty
images (needs an ntk ARGB upload path — new PRD), kitty keyboard protocol,
`Terminal.attach()` for pre-existing PTYs (SSH multiplexers).

Upstream PRs/issues filed **at M2 start** (so they can land while we ride
escape hatches): ntk `Surface.copyWithin`, ntk `fillRects`, ntk
drawGlyphs/`glyphIdFor` blessing, react-x11 `altKey`/`metaKey`, xterm.js
`mouseEncoding` + underline color exposure. Each adoption = delete a hatch
behind `RendererOps` + lockfile bump (repo memory rule).

---

## 15. Open questions (decision needed, defaults proposed)

1. **Tab/Escape bargain vs full-screen apps** — proposed: arm-on-Escape only
   on the primary screen; alt-screen traps focus (pointer leaves). Alt.:
   dedicated Ctrl+Shift+Tab leave-chord always. Needs maintainer taste call.
2. **PTY dependency posture** — proposed: both `node-pty` and
   `@lydell/node-pty` as optional peers, probe in that order. Alt.: bless the
   lydell fork as `optionalDependencies` for out-of-box vt (13.5 KB + one
   platform binary) at the cost of a beta dep. Leaning proposed-as-written.
3. **`@xterm/headless` posture** — optionalDependency (default-installed,
   2 MB) as proposed, or optional peer (zero closure, one more install step)?
   Leaning optionalDependency: the component should work out of the box up to
   the native-module boundary.
4. **`auto` ordering end-state** — when (if ever) does vt move ahead of the
   external emulators? Proposed: revisit after M3 with real-usage feedback;
   not before.
5. **Scrollable mixin** — deliberately _not_ used (its model is pixel-scroll
   of yoga content; terminal scrollback is line-addressed within a fixed
   rect). Confirm nobody expects `overflow: 'scroll'` semantics on the
   element.
6. **Fallback fonts for CJK width mismatches** — accept the classic
   half-glyph-overlap when a fallback's advance disagrees with the cell, or
   scale-to-fit? Proposed: accept (every terminal does).

---

## 16. Risks

| Risk                                                           | Exposure                            | Mitigation                                                                                                                          |
| -------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| ntk internals drift under hatches #1–#3 (git-pinned dep moves) | build/runtime breakage on lock bump | probes + DirectRenderer fallback; promotion table filed early; hatches confined to `renderer.ts`/`fonts.ts`                         |
| node-pty install failures / missing                            | vt unavailable on some machines     | optional peers + `'unavailable'` + fallback prop; two providers probed                                                              |
| xterm.js major-version API drift (v6→v7)                       | structural types stop matching      | types are _ours_ (slice), CI runs against a pinned version; upgrade is a deliberate PR                                              |
| In-process JS X server lacks Present/Render features used      | CI-only false negatives             | RetainedRenderer probes; pixel tests already pass through ntk's CopyArea fallback path; keep DirectRenderer tests primary for logic |
| Grid metrics vs proportional fallback glyphs                   | cosmetic overlap                    | grid-positioned draws clip naturally per following cells' repaints; accepted (§15.6)                                                |
| `MAX_DAMAGE_RECTS` merges scattered rows into big bands        | over-blit (not over-render)         | we pre-band; blits are cheap composites; measured in bench                                                                          |
| Focus-model surprises (key routing, focus-visible ring)        | UX papercuts                        | reuse code-editor's proven patterns; pixel/behavior tests for focus states                                                          |

---

## 17. Appendix: verified reference index

react-x11 (pinned `3b3691a`): `registerElement` registry.js; damage cap
`nodes.js:312`; `Node.invalidate` forwarding `nodes.js:2264`; window collector
`nodes.js:7155`; discrete key tier + Tab cycle `events.js:872` area; key event
fields (no alt/meta) events.js `_onKey`; clipboard PRIMARY `clipboard.js` +
`index.d.ts` ClipboardOptions; `measureContent` seam node.d.ts; testing
pixels `testing/pixels.js`; trace hooks via `react-x11/debug`.

ntk 7.5.0: `Surface` surface.js; `drawImage` direct composite
renderingcontext_2d.js:3035; `drawGlyphs` :1408 (+ rect-clip fast path);
glyph pages/budgets text/glyphs.js; fonts text/fontmanager.js, text/font.js;
`scrollRegion` window.js:996; frame clock + rAF window.js:1046–1594; expose
service window.js:908; solid pictures app.js `solidPicture`.

`@xterm/headless` 6.0.0 typings: `IBuffer` (cursorX/Y, viewportY, baseY),
`IBufferCell` (color modes doc-blessed for comparison; `isUnderline():
number`), `IModes` (tracking, appCursor, bracketedPaste, sendFocus),
`IParser.registerCsiHandler/registerOscHandler`, `scrollLines`, options
(scrollback, cursorStyle/Blink, drawBoldTextInBrightColors,
minimumContrastRatio).

Existing code this builds on: `src/terminal/index.ts` (props/handle,
"write() reserved" note), `src/embed/host.ts` (`ProcessHost` seam shape),
`src/code-editor/node.ts` (registered-node idioms: default actions, blink,
clipboard, invalidate, measure).
