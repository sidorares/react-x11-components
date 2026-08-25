// Run with: npm run examples:table-non-virtual [-- <rows>]   (needs a real $DISPLAY)
//
// The control group for `examples/table.tsx`: the same window, the same
// data, the same look — and no `<Table>` anywhere. Every log line is a real
// row of elements inside a plain `overflow: 'scroll'` box, so what the
// scroll view clips is all the virtualization there is. It exists to answer
// one question honestly: how far does regular clipping get before the
// windowed table earns its machinery?
//
// What to compare, with the row count as the variable (default the same
// hundred thousand as table.tsx; pass a smaller one to find the knee):
//
//   - **Startup.** Every row is built, laid out and measured up front; the
//     time from launch to the first laid-out frame is printed to stdout.
//   - **Scrolling.** Once built, a wheel flick is core's blit path over
//     content that never changes — no re-slicing, no skeletons, nothing to
//     catch up on. This is the part plain clipping is genuinely good at.
//   - **Appending.** The tail button re-renders a list of N children so
//     React can reconcile the 500 new ones, and the naive "scroll to the
//     bottom" here clamps against the *previous* layout's content height —
//     the exact race `<Table>`'s scrollToRow debt exists to win — so it
//     waits a beat before scrolling. The append time is printed too.
//
// The rows are memoized the way a careful app would write them, so a click
// re-renders two rows rather than all of them. That is the fair hand-rolled
// baseline; without it, every interaction pays for the whole list.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement } from 'react';
import { execFileSync } from 'node:child_process';
import { Button, Icon, SplitPane, createRoot, useTheme } from 'react-x11';
import type { ScrollableNode } from 'react-x11';

const COUNT = Number(process.argv[2]) || 100_000;
const LAUNCHED = performance.now();

// --- the same data table.tsx generates --------------------------------------

interface Proc {
  id: number;
  cpu: number;
  mem: number;
  command: string;
}

function listProcesses(): Proc[] {
  const out = execFileSync('ps', ['axo', 'pid=,pcpu=,pmem=,comm='], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, cpu, mem, ...comm] = line.split(/\s+/);
      return {
        id: Number(pid),
        cpu: Number(cpu),
        mem: Number(mem),
        command: comm.join(' '),
      };
    })
    .sort((a, b) => b.cpu - a.cpu);
}

interface Entry {
  id: number;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

const SOURCES = ['renderer', 'compositor', 'dbus', 'net', 'fs'];
const PHRASES = [
  'frame flushed',
  'damage coalesced into one strip after the scroll settled',
  'selection ownership taken',
  'reconnecting after the peer closed the stream mid-reply, backing off',
  'cache warmed',
  'layout pass converged in two rounds after the viewport report arrived late',
];

function makeEntries(n: number, from = 0): Entry[] {
  const entries: Entry[] = [];
  let seed = (0x5eed + from) & 0x7fffffff;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < n; i++) {
    const roll = rand();
    const id = from + i;
    entries.push({
      id,
      level: roll < 0.82 ? 'info' : roll < 0.95 ? 'warn' : 'error',
      source: SOURCES[Math.floor(rand() * SOURCES.length)],
      message: `${PHRASES[Math.floor(rand() * PHRASES.length)]} (#${id})`,
    });
  }
  return entries;
}

/** table.tsx's default sort, done by hand: source ascending, stable. */
function bySource(entries: readonly Entry[]): Entry[] {
  return [...entries].sort((a, b) =>
    a.source === b.source ? 0 : a.source < b.source ? -1 : 1,
  );
}

const LEVEL_COLOR: Record<Entry['level'], string> = {
  info: '$textMuted',
  warn: '#e5a50a',
  error: '#e01b24',
};

// --- the hand-rolled rows ----------------------------------------------------

/** One log line: the dot, the source, the wrapping message — the same three
 *  cells the table's column model produces, minus the model. Memoized so a
 *  selection change re-renders two of these, not all of them. */
const LogRow = React.memo(function LogRow({
  entry,
  zebra,
  selected,
  onSelect,
}: {
  entry: Entry;
  zebra: boolean;
  selected: boolean;
  onSelect: (id: number) => void;
}): ReactElement {
  const theme = useTheme();
  const color = selected ? theme.hoverText : theme.text;
  return (
    <box
      onClick={() => onSelect(entry.id)}
      style={{
        flexDirection: 'row',
        flexShrink: 0,
        cursor: 'pointer',
        backgroundColor: selected
          ? theme.hoverBackground
          : zebra
            ? theme.surfaceHover
            : 'transparent',
        color,
      }}
    >
      <box
        style={{
          width: 28,
          flexShrink: 0,
          paddingStart: 8,
          justifyContent: 'center',
        }}
      >
        <Icon name="dot" size={8} color={LEVEL_COLOR[entry.level]} />
      </box>
      <box style={{ width: 96, flexShrink: 0, justifyContent: 'center' }}>
        <text style={{ fontSize: 12, textWrap: 'nowrap', color }}>
          {entry.source}
        </text>
      </box>
      <box
        style={{
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
          paddingStart: 8,
          paddingEnd: 8,
          justifyContent: 'center',
        }}
      >
        <text style={{ fontSize: 12, color }}>{entry.message}</text>
      </box>
    </box>
  );
});

function HeaderCell({
  label,
  width,
}: {
  label: string;
  width?: number;
}): ReactElement {
  const theme = useTheme();
  return (
    <box
      style={{
        width,
        flexGrow: width === undefined ? 1 : 0,
        flexShrink: 0,
        height: 24,
        paddingStart: 8,
        justifyContent: 'center',
      }}
    >
      <text style={{ fontSize: 12, textWrap: 'nowrap', color: theme.text }}>
        {label}
      </text>
    </box>
  );
}

function Logs({
  entries,
  scroller,
}: {
  entries: readonly Entry[];
  scroller: { current: ScrollableNode | null };
}): ReactElement {
  const theme = useTheme();
  const [picked, setPicked] = useState<number | null>(null);
  const onSelect = useCallback((id: number) => setPicked(id), []);
  const sorted = useMemo(() => bySource(entries), [entries]);
  const rows = sorted.map((entry, i) => (
    <LogRow
      key={entry.id}
      entry={entry}
      zebra={i % 2 === 1}
      selected={picked === entry.id}
      onSelect={onSelect}
    />
  ));
  return (
    <box style={{ flexGrow: 1, minHeight: 0 }}>
      <box
        style={{
          flexDirection: 'row',
          flexShrink: 0,
          backgroundColor: theme.surfaceHover,
        }}
      >
        <HeaderCell label="" width={28} />
        <HeaderCell label="Source" width={96} />
        <HeaderCell label="Message" />
      </box>
      <box
        ref={scroller as never}
        style={{ flexGrow: 1, minHeight: 0, overflow: 'scroll' }}
      >
        {rows}
      </box>
      <box
        style={{
          flexShrink: 0,
          flexDirection: 'row',
          paddingStart: 8,
          paddingTop: 4,
          paddingBottom: 4,
          borderTopWidth: 1,
          borderColor: theme.border,
        }}
      >
        <text style={{ fontSize: 11, color: theme.textMuted }}>
          {`${entries.length} rows, every one a real node — the non-virtual control group`}
        </text>
      </box>
    </box>
  );
}

function Processes(): ReactElement {
  const theme = useTheme();
  const processes = useMemo(listProcesses, []);
  return (
    <box style={{ flexGrow: 1, minHeight: 0 }}>
      <box
        style={{
          flexDirection: 'row',
          flexShrink: 0,
          backgroundColor: theme.surfaceHover,
        }}
      >
        <HeaderCell label="PID" width={64} />
        <HeaderCell label="CPU %" width={72} />
        <HeaderCell label="Command" />
      </box>
      <box style={{ flexGrow: 1, minHeight: 0, overflow: 'scroll' }}>
        {processes.map((p) => (
          <box
            key={p.id}
            style={{ flexDirection: 'row', flexShrink: 0, height: 22 }}
          >
            <box
              style={{
                width: 64,
                flexShrink: 0,
                alignItems: 'flex-end',
                paddingEnd: 8,
                justifyContent: 'center',
              }}
            >
              <text style={{ fontSize: 12, color: theme.text }}>
                {String(p.id)}
              </text>
            </box>
            <box
              style={{
                width: 72,
                flexShrink: 0,
                alignItems: 'flex-end',
                paddingEnd: 8,
                justifyContent: 'center',
              }}
            >
              <text style={{ fontSize: 12, color: theme.text }}>
                {String(p.cpu)}
              </text>
            </box>
            <box
              style={{
                flexGrow: 1,
                flexShrink: 1,
                minWidth: 0,
                paddingStart: 8,
                justifyContent: 'center',
              }}
            >
              <text
                style={{ fontSize: 12, textWrap: 'nowrap', color: theme.text }}
              >
                {p.command}
              </text>
            </box>
          </box>
        ))}
      </box>
    </box>
  );
}

// --- the window --------------------------------------------------------------

function App(): ReactElement {
  const [entries, setEntries] = useState<Entry[]>(() => makeEntries(COUNT));
  const scroller = useRef<ScrollableNode | null>(null);
  const appendedAt = useRef<number | null>(null);
  const booted = useRef(false);

  useEffect(() => {
    // First layout of the whole list — the startup cost regular clipping
    // pays up front. Read on the tick after the commit, when layout has run.
    if (!booted.current) {
      booted.current = true;
      setTimeout(() => {
        console.log(
          `[non-virtual] ${COUNT} rows built and laid out in ` +
            `${(performance.now() - LAUNCHED).toFixed(0)}ms from launch`,
        );
      }, 0);
      return;
    }
    const t0 = appendedAt.current;
    appendedAt.current = null;
    // The naive tail: scroll to "the bottom", where the bottom is whatever
    // the *last* layout measured — the new rows are not in it yet. Waiting a
    // couple of frames is the hand-rolled workaround for the race that
    // <Table>'s scrollToRow debt retries through properly.
    setTimeout(() => {
      scroller.current?.scrollTo({ y: Number.MAX_SAFE_INTEGER });
      if (t0 !== null) {
        console.log(
          `[non-virtual] append of 500 settled in ` +
            `${(performance.now() - t0).toFixed(0)}ms`,
        );
      }
    }, 50);
  }, [entries]);

  return (
    <window
      title="Table, non-virtual — every row a node"
      style={{ width: 980, height: 560 }}
    >
      <box
        style={{
          flexShrink: 0,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          padding: 8,
          borderBottomWidth: 1,
          borderColor: '$border',
        }}
      >
        <Button
          label="Append 500 rows & scroll to last"
          onPress={() => {
            appendedAt.current = performance.now();
            setEntries((prev) => [...prev, ...makeEntries(500, prev.length)]);
          }}
        />
        <text style={{ fontSize: 11, color: '$textMuted' }}>
          the same window as examples/table.tsx, with no Table in it
        </text>
      </box>
      <SplitPane
        direction="row"
        defaultSize={340}
        style={{ flexGrow: 1, minHeight: 0 }}
      >
        <Processes />
        <Logs entries={entries} scroller={scroller} />
      </SplitPane>
    </window>
  );
}

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
