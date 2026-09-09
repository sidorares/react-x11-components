// Run with: npm run examples:terminal-vt   (needs an X server / DISPLAY. It
// needs no terminal emulator installed, which is the whole point of this
// backend, and the pty it does need is already a devDependency here —
// `@lydell/node-pty`, 220 KB.)
//
// On macOS it runs on react-x11's native Cocoa backend, the default there
// since 2.3: the glyph-run seams and the offscreen Surface this renderer
// needs arrived in react-x11 2.4.0 and 2.5.0 (sidorares/react-x11#432 and
// #433), which is this package's floor. `REACT_X11_BACKEND=x11 …` under
// XQuartz is the A/B run.
//
// **`npm install node-pty` in this repo installs nothing**, and exits 0 while
// doing it: this package *declares* node-pty as an optional peer dependency,
// so npm treats the request as already satisfied by the declaration and
// writes only the lockfile. In an app that consumes this package it is an
// ordinary `npm i node-pty`; in here, use `npm i --save-dev node-pty` (and do
// not commit it — 64 MB) if you want to test against that provider rather
// than the fork.
//
// The same component as `terminal.tsx` with one prop changed, and three
// things that only work this way:
//
//  - **`write()` is real.** The pty is ours, so the buttons below type into
//    the shell rather than pretending to.
//  - **The selection is ours too**, so `onSelectionChange` fires and the text
//    lands on PRIMARY for a middle-click paste anywhere else.
//  - **Theme colours apply exactly**, palette and all — this renderer is the
//    one resolving them — and because this is a drawn element rather than a
//    child X window, a `<popup>` would composite *above* it, which over an
//    embedded xterm is impossible. The `frames:` menu below is that popup,
//    and it drops over the terminal rather than beside it.
//
// ### The `frames:` menu, and what it is really setting
//
// A terminal fed by a pty claims a repaint every time the emulator says the
// screen moved, which under `cat` of a large file is far more often than
// anyone can read. What decides whether those claims become frames is
// **the window's `frameRate`** (react-x11 2.9's `src/pacing.js`) — not a
// prop on `<Terminal>`: pacing is a property of the surface the frames go
// to, so one policy covers the terminal, the toolbar and everything else in
// the window, and an app sets it once per window (or for every window, with
// `createRoot({ frameRate })` / `REACT_X11_FRAME_RATE`).
//
// The rule is a token bucket over *paint time*, not a rate: credit accrues
// at `budget` ms per ms of wall time, a frame spends what it cost, and a
// claim that finds the bucket in debt waits for it to refill. So idle is
// immediate — a keystroke after a pause never waits, whatever the last
// frame cost — cheap frames are never held, and only a *stream* of
// expensive ones throttles, to exactly `budget`'s share of the thread.
// `minFps` is the floor under that wait; `maxFps` a ceiling over even cheap
// frames.
//
// **`throughput` is the entry to pick for large output** — a tenth of the
// thread, a 10fps floor, a 30fps ceiling. That is the trade this example
// exists to make visible, and `flood` is how to see it: press it on
// `display` and then on `throughput`, and read the `time` the shell itself
// prints. Nothing here is timing anything, which is the point — the number
// comes from the program, not from the renderer's opinion of itself.
//
// Which way it goes depends on the backend, and the gap is a Cocoa one.
// There the frame clock is the display's own period and every frame's pixel
// work runs on the JS thread, so the default spends a flood painting
// screens nobody can read while the pty reader waits its turn:
// docs/prd-frame-pacing.md §2 measures 3.50s of `cat` under `display`
// against 0.95s paced, on a 120Hz panel. Under X11 the two are close, and
// the pacer usually holds nothing: an X11 frame is fenced by a server round
// trip, so the flood is already paced by backpressure.
import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Icon, createRoot, useTheme } from 'react-x11';
import type { DrawnNode, FrameRate, KeyboardEvent } from 'react-x11';
import { XK_DOWN, XK_ESCAPE, XK_RETURN, XK_UP } from 'react-x11/keysyms';

import { Terminal } from '../src/index.js';
import type { TerminalHandle } from '../src/index.js';

/**
 * The policies the menu offers, from "paint everything" to "the output is
 * the point".
 *
 * Module-level and never rebuilt, because `<window frameRate>` re-resolves
 * on a change of *identity*: an object literal in the render would re-arm
 * the pacer every pass. The first three are core's presets by name, the two
 * numbers are the plain ceiling every terminal has ever had, and `crawl` is
 * the three fields spelled out — past `throughput`, for the run where the
 * only thing that matters is when the command finishes.
 */
const FRAME_RATES = [
  {
    key: 'display',
    label: 'display',
    detail: 'every frame the clock gives — the default',
    value: 'display',
  },
  {
    key: 'adaptive',
    label: 'adaptive',
    detail: 'paints under a quarter of the thread, 20fps floor',
    value: 'adaptive',
  },
  {
    key: 'throughput',
    label: 'throughput',
    detail: 'a tenth, 10fps floor, 30fps ceiling — the one for floods',
    value: 'throughput',
  },
  {
    key: '60',
    label: '60 fps',
    detail: 'a ceiling and nothing else: no budget, no floor',
    value: 60,
  },
  {
    key: '30',
    label: '30 fps',
    detail: 'the same ceiling, half as often',
    value: 30,
  },
  {
    key: 'crawl',
    label: 'crawl',
    detail: 'budget 0.05, 5fps floor, 15fps ceiling — throughput over all',
    value: { budget: 0.05, minFps: 5, maxFps: 15 },
  },
] as const satisfies readonly {
  key: string;
  label: string;
  detail: string;
  value: FrameRate;
}[];

type FrameRateChoice = (typeof FRAME_RATES)[number];

const MENU_WIDTH = 340;

/**
 * The `frames:` dropdown — a button and a `<popup>`, which is the only shape
 * a menu can take here: the popup is its own X window, so it stacks above
 * the terminal's pixels rather than being laid out around them.
 *
 * The popup grabs the pointer (`grab`) so a press anywhere else dismisses
 * it, and the button keeps the keyboard while it is open — Down/Up walk,
 * Enter commits, Escape shuts — rather than handing focus to a window the
 * next click is going to destroy.
 */
function FrameRateMenu({
  choice,
  onChoose,
}: {
  choice: FrameRateChoice;
  onChoose: (next: FrameRateChoice) => void;
}): ReactElement {
  const theme = useTheme();
  const trigger = useRef<DrawnNode>(null);
  const [open, setOpen] = useState(false);
  // -1 is "nothing yet": a menu dropped with the mouse lights no row until
  // the pointer or the arrows have said which, so Enter cannot commit a row
  // nobody chose.
  const [active, setActive] = useState(-1);

  const chosen = FRAME_RATES.indexOf(choice);
  const close = (): void => setOpen(false);

  const commit = (index: number): void => {
    const next = FRAME_RATES[index];
    if (!next) return;
    close();
    onChoose(next);
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.keysym === XK_ESCAPE) {
      if (!open) return;
      close();
    } else if (ev.keysym === XK_DOWN || ev.keysym === XK_UP) {
      const step = ev.keysym === XK_DOWN ? 1 : -1;
      if (!open) {
        // Opened from the keyboard, so it opens on the row that is current.
        setActive(chosen);
        setOpen(true);
      } else {
        setActive((at) => {
          const from = at < 0 ? chosen : at;
          const n = FRAME_RATES.length;
          return (((from + step) % n) + n) % n;
        });
      }
    } else if (ev.keysym === XK_RETURN || ev.codepoint === 32) {
      if (!open) {
        setActive(chosen);
        setOpen(true);
      } else commit(active < 0 ? chosen : active);
    } else return;
    ev.preventDefault();
    ev.stopPropagation();
  };

  return (
    <box
      ref={trigger}
      role="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label="frame rate"
      focusable
      tabIndex={0}
      onMouseDown={() => {
        setActive(-1);
        setOpen((was) => !was);
      }}
      onKeyDown={onKeyDown}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        padding: 6,
        borderRadius: 4,
        backgroundColor: open ? '$surface' : '$surfaceActive',
        cursor: 'pointer',
      }}
    >
      <text style={{ fontSize: 11, color: '$textMuted' }}>frames:</text>
      <text style={{ fontSize: 11, color: '$text' }}>{choice.label}</text>
      <Icon name="chevronDown" size={9} />

      {open && (
        <popup
          // A popup is a window of its own and inherits no palette, so the
          // `$token` values in its subtree need the theme handed over. The
          // cast is `<window theme>`'s narrower declaration, which the
          // components here work around the same way (`src/tabs/hx.ts`).
          theme={theme as Record<string, string | number>}
          width={MENU_WIDTH}
          anchor={{ to: trigger, placement: 'bottom', align: 'end' }}
          grab
          onDismiss={close}
          style={{ backgroundColor: '$background' }}
        >
          <box
            role="menu"
            style={{
              flexGrow: 1,
              padding: 4,
              gap: 2,
              borderWidth: 1,
              borderColor: '$border',
              backgroundColor: '$background',
            }}
          >
            {FRAME_RATES.map((rate, index) => (
              <box
                key={rate.key}
                role="menuitemradio"
                aria-checked={index === chosen}
                onMouseEnter={() => setActive(index)}
                onClick={() => commit(index)}
                style={{
                  gap: 2,
                  paddingLeft: 8,
                  paddingRight: 8,
                  paddingTop: 5,
                  paddingBottom: 5,
                  borderRadius: 4,
                  cursor: 'pointer',
                  ...(index === active && {
                    backgroundColor: '$surfaceHover',
                  }),
                }}
              >
                <text
                  style={{
                    fontSize: 12,
                    color: '$text',
                    // The current policy is marked rather than filled: the
                    // fill is where the cursor is, and both can be one row.
                    fontWeight: index === chosen ? 'bold' : 'normal',
                  }}
                >
                  {index === chosen ? `• ${rate.label}` : rate.label}
                </text>
                <text style={{ fontSize: 11, color: '$textMuted' }}>
                  {rate.detail}
                </text>
              </box>
            ))}
          </box>
        </popup>
      )}
    </box>
  );
}

// A flood that reports its own cost, so the trade the menu makes is a number
// the terminal prints rather than a claim in a comment: 200,000 *distinct*
// wide lines (a repeated line is a diff the renderer can skip), generated by
// awk because a shell loop would be measuring the shell. `time` is a keyword
// in both bash and zsh, and it is the shell's own clock — nothing here is
// timing itself.
const FLOOD =
  "time awk 'BEGIN { for (i = 0; i < 200000; i++) " +
  'print i " the quick brown fox jumps over the lazy dog" }\'\r';

function App(): ReactElement {
  const terminal = useRef<TerminalHandle>(null);
  const [title, setTitle] = useState('shell');
  const [status, setStatus] = useState('starting…');
  const [selected, setSelected] = useState('');
  const [rate, setRate] = useState<FrameRateChoice>(FRAME_RATES[0]);

  return (
    <window
      width={940}
      height={520}
      title="@react-x11/components — vt Terminal"
      // The whole point of the menu: the policy belongs to the window, and
      // a change of it re-arms the pacer on the next claim.
      frameRate={rate.value}
    >
      <box style={{ flexGrow: 1, flexDirection: 'column' }}>
        <box
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            padding: 8,
            backgroundColor: '$surfaceHover',
          }}
        >
          <text style={{ fontSize: 13, color: '$text', flexGrow: 1 }}>
            {title}
          </text>
          <text style={{ fontSize: 11, color: '$textMuted' }}>{status}</text>
          {[
            ['ls -la\r', 'ls'],
            ['git status\r', 'git status'],
            [FLOOD, 'flood'],
            ['\x03', 'Ctrl+C'],
          ].map(([bytes, label]) => (
            <box
              key={label}
              style={{
                padding: 6,
                borderRadius: 4,
                backgroundColor: '$surfaceActive',
                cursor: 'pointer',
              }}
              // The reserved method, real at last: straight into the pty.
              onClick={() => terminal.current?.write(bytes)}
            >
              <text style={{ fontSize: 11, color: '$text' }}>{label}</text>
            </box>
          ))}
          <box
            style={{
              padding: 6,
              borderRadius: 4,
              backgroundColor: '$surfaceActive',
              cursor: 'pointer',
            }}
            onClick={() => {
              setStatus('restarting…');
              terminal.current?.restart();
            }}
          >
            <text style={{ fontSize: 11, color: '$text' }}>restart</text>
          </box>
          <FrameRateMenu choice={rate} onChoose={setRate} />
        </box>

        <Terminal
          backend="vt"
          ref={terminal}
          fontFamily="monospace"
          fontSize={14}
          scrollback={5000}
          cursorStyle="block"
          bell="visual"
          style={{ flexGrow: 1, padding: 6 }}
          onTitleChange={setTitle}
          onSelectionChange={setSelected}
          onExit={({ code, signal }) =>
            setStatus(signal ? `killed (${signal})` : `exited ${code}`)
          }
          onError={(err) => setStatus(err.message)}
          fallback={
            // `status` is whatever `onError` last said, which separates "no
            // pty module here" from "there is one and it would not load" —
            // printing a fixed "install node-pty" would be a lie in the
            // second case, and the second case is the confusing one.
            <box style={{ flexGrow: 1, padding: 24, gap: 8 }}>
              <text style={{ fontSize: 13, color: '$text' }}>
                The vt backend is unavailable.
              </text>
              <text style={{ fontSize: 12, color: '$textMuted' }}>
                {status}
              </text>
            </box>
          }
        />

        <box
          style={{
            flexDirection: 'row',
            gap: 8,
            padding: 6,
            backgroundColor: '$surfaceHover',
          }}
        >
          <text style={{ fontSize: 11, color: '$textMuted', flexGrow: 1 }}>
            {selected
              ? `selected ${selected.length} chars — also on PRIMARY`
              : 'drag to select; middle-click pastes; Ctrl+Shift+C/V for the clipboard'}
          </text>
          <text style={{ fontSize: 11, color: '$textMuted' }}>
            {`frameRate ${rate.label} — ${rate.detail}`}
          </text>
        </box>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
