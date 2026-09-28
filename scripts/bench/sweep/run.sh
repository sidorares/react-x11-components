#!/usr/bin/env bash
# Every probe in this directory on each backend, one JSON line per cell, into
# $1. SUITES narrows it (default: "frames maps charts table docs editors
# flow" — `frames` is ../frames, what a frame shows rather than what it costs);
# BACKENDS the backends (default: "x11 cocoa" on a Mac, "x11" elsewhere). A
# cell that prints no RESULT is recorded as {"failed": "<probe> <env>"} and
# the run goes on.
#
#   scripts/bench/sweep/run.sh results.jsonl
#   SUITES="docs editors" BACKENDS=cocoa scripts/bench/sweep/run.sh docs.jsonl
#
# Plain bash, and bash 3.2 at that — the one a Mac ships — so it runs on a
# Linux desktop, where there is often no zsh, as well as on the Mac it was
# first written for.
set -u
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: run.sh <out.jsonl>}
: >"$out"
SUITES=${SUITES:-"frames maps charts table docs editors flow"}
if [ "$(uname)" = Darwin ]; then
  BACKENDS=${BACKENDS:-"x11 cocoa"}
else
  BACKENDS=${BACKENDS:-"x11"}
fi
has() { case " $SUITES " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# Whether the screen was up: `on`, `off` (DPMS switched the monitor off) or
# either with `,saver` when a screensaver was in front. Off, Present has no
# display behind it, so ntk's windows fall to the fence clock for good; a
# screensaver throttles the window manager, and Cinnamon's Muffin then
# applies a client's resize about once a second. A cell measured either way
# measured something else, so each records it and tabulate.ts says so.
# `unknown` on a Mac, where neither is asked.
display_state() {
  if [ "$(uname)" = Darwin ]; then
    printf unknown
    return
  fi
  local state=on svc
  if xset q 2>/dev/null | grep -q 'Monitor is Off'; then state=off; fi
  for svc in org.cinnamon.ScreenSaver org.gnome.ScreenSaver org.mate.ScreenSaver org.freedesktop.ScreenSaver; do
    if dbus-send --session --dest="$svc" --print-reply --reply-timeout=500 \
      "/$(printf %s "$svc" | tr . /)" "$svc.GetActive" 2>/dev/null | grep -q 'boolean true'; then
      state="$state,saver"
      break
    fi
  done
  printf %s "$state"
}

# one cell: the probe, its environment, a two-and-a-half-minute ceiling
cell() {
  local probe=$1
  shift
  local line before after
  before=$(display_state)
  line=$(env "$@" perl -e 'alarm 150; exec @ARGV' npx tsx "$here/$probe" 2>&1 | grep '^RESULT' | sed 's/^RESULT //')
  after=$(display_state)
  if [ -n "$line" ]; then
    printf '%s\n' "$line" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); d["env"]=sys.argv[1]; d["display"]=sys.argv[2] if sys.argv[2]==sys.argv[3] else sys.argv[2]+">"+sys.argv[3]; print(json.dumps(d))' "$*" "$before" "$after" >>"$out"
  else
    printf '{"failed":"%s %s"}\n' "$probe" "$*" >>"$out"
  fi
}

for b in $BACKENDS; do
  # X11 only: its watcher and its readback are X clients
  if has frames && [ "$b" = x11 ]; then
    for sc in widgets charts; do
      for gl in 0 1; do cell ../frames/drag.tsx REACT_X11_BACKEND=$b SCENE=$sc GL=$gl; done
    done
    for sc in widgets charts fanout lattice; do cell ../frames/renderers.tsx REACT_X11_BACKEND=$b SCENE=$sc; done
  fi
  # Cocoa only: its capture is ScreenCaptureKit, and it needs Screen Recording
  if has frames && [ "$b" = cocoa ]; then
    for gl in 0 1; do cell ../frames/e2p.tsx REACT_X11_BACKEND=$b GL=$gl; done
  fi
  if has maps; then
    for r in retained gl; do
      for a in pan drag wheel fly; do cell mapsweep.tsx REACT_X11_BACKEND=$b RENDERER=$r ACTION=$a; done
    done
  fi
  if has charts; then
    for a in stream pan1m zoom1m multiples scatter scroll; do cell chartsweep.tsx REACT_X11_BACKEND=$b ACTION=$a; done
  fi
  if has table; then
    for a in wheel fling thumb jump; do cell tablesweep.tsx REACT_X11_BACKEND=$b ACTION=$a; done
  fi
  if has docs; then
    for c in md html; do
      for a in mount edit insert append scroll reflow; do cell docsweep.tsx REACT_X11_BACKEND=$b COMP=$c ACTION=$a; done
    done
  fi
  if has editors; then
    for a in mount scroll type-end type-mid type-start undo replace long-mount long-type caret-down enter-end jump-end; do
      cell editorsweep.tsx REACT_X11_BACKEND=$b COMP=code ACTION=$a
    done
    cell editorsweep.tsx REACT_X11_BACKEND=$b COMP=code ACTION=type-mid PLAIN=1
    for a in mount scroll type-mid type-long bold-all paste; do cell editorsweep.tsx REACT_X11_BACKEND=$b COMP=rte ACTION=$a; done
    cell editorsweep.tsx REACT_X11_BACKEND=$b COMP=rte ACTION=type-mid SIZE=1000
  fi
  if has flow; then
    for gl in 0 1; do
      for sc in lattice lattice2000 fanout widgets charts; do
        cell matrix.tsx REACT_X11_BACKEND=$b GL=$gl SCENE=$sc ACTION=pan ZOOM=0.5
        cell matrix.tsx REACT_X11_BACKEND=$b GL=$gl SCENE=$sc ACTION=pan ZOOM=1
        cell matrix.tsx REACT_X11_BACKEND=$b GL=$gl SCENE=$sc ACTION=zoom ZOOM=0.8
        cell matrix.tsx REACT_X11_BACKEND=$b GL=$gl SCENE=$sc ACTION=wheel ZOOM=0.8
        cell matrix.tsx REACT_X11_BACKEND=$b GL=$gl SCENE=$sc ACTION=drag ZOOM=1
      done
      # the flow-stress example's pane, where the 2 fps report came from
      for map in 0 1; do
        cell matrix.tsx REACT_X11_BACKEND=$b GL=$gl SCENE=widgets ACTION=pan ZOOM=0.455 W=1686 H=1180 VX=208 VY=101 MAP=$map
      done
    done
  fi
done
