# The performance sweep's probes

The programs behind `docs/perf-sweep-2026-09.md`. Each mounts one component
in a real window on the backend `REACT_X11_BACKEND` names (`x11`, `cocoa`),
drives it on a wall-clock timer for a few seconds, and prints one line:

```
RESULT {"suite":"docs","comp":"md","action":"edit","backend":"cocoa","fps":9,"frame50":19.66,"lat50":46.5,"cpu":74,…}
```

They need a display — a real `$DISPLAY` for `x11`, a Mac for `cocoa` — and
the window has to stay uncovered: an occluded Cocoa window gets no frames.

| Probe             | What                                     | `ACTION=`                                                                                                                                          |
| ----------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `matrix.tsx`      | `<Flow>`, five scenes                    | `pan`, `zoom`, `wheel`, `drag` (`SCENE`, `GL`, `ZOOM`, `MAP`)                                                                                      |
| `mapsweep.tsx`    | `<Map>`, London z15                      | `pan`, `drag`, `wheel`, `fly` (`RENDERER=retained\|gl`; tiles from `BENCH_TILES`)                                                                  |
| `chartsweep.tsx`  | the charts                               | `stream`, `pan1m`, `zoom1m`, `multiples`, `scatter`, `scroll`                                                                                      |
| `tablesweep.tsx`  | `<Table>`, 100,000 log rows              | `wheel`, `fling`, `thumb`, `jump`                                                                                                                  |
| `docsweep.tsx`    | `<Markdown>`, `<Html>` (`COMP=md\|html`) | `mount`, `edit`, `append`, `scroll`, `reflow` (`SIZE` sections, default 300 ≈ 600 KB)                                                              |
| `editorsweep.tsx` | `<CodeEditor>` (`COMP=code`)             | `mount`, `scroll`, `type-end`, `type-mid`, `type-start`, `undo`, `replace`, `long-mount`, `long-type` (`LINES`, `LONG`, `PLAIN=1` for no language) |
| `editorsweep.tsx` | `<RichTextEditor>` (`COMP=rte`)          | `mount`, `scroll`, `type-mid`, `type-hidden`, `type-long`, `bold-all`, `paste` (`SIZE`)                                                            |
| `docgen.ts`       | the documents                            | a report of N sections, deterministic by seed; the Markdown and HTML spellings of the same content                                                 |

What the fields mean: `fps` — frames that painted, per second; `frame50`,
`frame95` — the window's flush time; `lat50`, `lat95` — from an input to the
end of the first flush that painted after it; `cpu` — this process, percent
of a core; `firstPaint`, `idle` — for mounts. A frame is
`WindowNode._flushFrame` answering that it painted.

## Running one

```bash
REACT_X11_BACKEND=cocoa COMP=md ACTION=edit npx tsx scripts/bench/sweep/docsweep.tsx
```

## Diagnostic modes

The flags that found this round's bugs, all off by default:

- `DIAG=1` — call and cache counters (`editorsweep`, `mapsweep`, `tablesweep`);
  for the editors, also every text layout split by kind (min-content,
  wrapped, one line).
- `STACKS=1` (with `DIAG=1`) — each layout's call stack, grouped.
- `DAMAGE=1` — every frame classified (blitted, poisoned, declined, no
  scroll) and how many windows' worth each kind painted.
- `TIMELINE=1` (with `DAMAGE=1`) — flush start and end, the pane's offset
  and the first visible block, around the middle of the run; add `CLAIMS=1`
  for every claim and every resized node in the frames that did not blit.
- `PHASES=1` (`docsweep`) — the window's frame phases timed per frame;
  `NO_FLOORS=1` replaces content floors with a plain layout, as a ceiling.

## The whole sweep

```bash
scripts/bench/sweep/run.sh results.jsonl
```

runs every probe on both backends — about half an hour on the machine
below, two thirds of it the Flow matrix. `SUITES="docs editors"` and `BACKENDS=cocoa` narrow it. Then

```bash
npx tsx scripts/bench/sweep/tabulate.ts results.jsonl scripts/bench/sweep/results-2026-09-25.jsonl
```

prints it as tables, one per suite, with a cell that moved by more than the
noise shown as `was → now` and marked `⚠` when it moved the wrong way. Leave
the second file off for the tables alone.

`results-2026-09-25.jsonl` is the final sweep of that round: components
`master` with #128 and #134, react-x11 2.22.4 with react-x11#702, ntk 8.12.2
with ntk#379, on an M1 Pro (Cocoa at scale 2, XQuartz 2.8.6 at scale 1). It
is a baseline for that machine only. Four of its cells are the median of
three reruns, because their first run was an outlier; a flagged cell in a
new sweep deserves the same before it is believed.

## Reading a profile

```bash
NODE_OPTIONS="--cpu-prof --cpu-prof-dir=prof" REACT_X11_BACKEND=cocoa COMP=code ACTION=type-mid npx tsx scripts/bench/sweep/editorsweep.tsx
npx tsx scripts/bench/sweep/cpuprofile.ts self prof
npx tsx scripts/bench/sweep/cpuprofile.ts callers prof lookup 4
```

`self` is where the time goes, `incl <regex>` how much passes through the
functions that match, `callers <function>` who spends a function's time,
and `tree <function>` everything under it, merged.

## A/B between two trees

A probe measures the tree whose `react-x11` it imports. To compare two
checkouts — a branch against `master`, a core change against the release —
give each its own install, copy the probes into its `node_modules/.bench/`
with a `package.json` that says `{"type": "module"}`, and point `BENCH_ROOT`
at that tree:

```bash
mkdir -p ../other/node_modules/.bench
cp scripts/bench/sweep/*.ts* ../other/node_modules/.bench/
echo '{"type":"module"}' > ../other/node_modules/.bench/package.json
cd ../other/node_modules/.bench && BENCH_ROOT=$PWD/../.. REACT_X11_BACKEND=x11 COMP=html ACTION=edit npx tsx docsweep.tsx
```

To try an unreleased core or ntk change, copy the changed files over that
tree's `node_modules/react-x11` or `node_modules/ntk` — `npm ci` puts them
back. Keeping the released copy of each file beside it (`git show
v2.22.4:src/nodes/layout.js` in a core checkout) turns that into a switch
you can flip between runs without a reinstall. Interleave the runs (A, B, A,
B), keep the machine idle, and do not run a test suite in the background:
it made one real improvement here look like a regression.
