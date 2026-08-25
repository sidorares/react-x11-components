// Run with: npm run examples:table   (needs a real $DISPLAY)
//
// The continuity ladder in one window (docs/prd-table.md: "ceremony is
// additive"). The left pane is the bottom rung: your processes, from the
// real `ps`, with **columns and rows and nothing else** — unsized columns
// stretch, the header sorts, clicking selects, and none of that was
// configured. The right pane is the same element several rungs up: a
// hundred thousand generated log lines, a custom cell with a level dot and
// a message that wraps — so rows are *not* one height, and the scrollbar is
// honest anyway — multiple selection with the file-manager grammar, zebra
// striping as one `styles.row` line, and a footer that reads the selection.
//
// Nothing on the right rewrote the left: every rung is a prop added to the
// same `<Table>`.
//
// The toolbar above both panes is the live-tail stress: "Append 500 rows &
// scroll to last" grows the log and reveals the newest row — the shape a
// protocol visualiser or a build log has, and the reveal follows the row
// wherever the active sort puts it.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, Ref } from 'react';
import { execFileSync } from 'node:child_process';
import { Button, Icon, SplitPane, createRoot, useTheme } from 'react-x11';

import { Table } from '../src/index.js';
import type { TableColumn, TableHandle, TableRowId } from '../src/index.js';

// --- rung one: the app's data, two columns, nothing else -------------------

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
    });
}

const PROC_COLUMNS: TableColumn<Proc>[] = [
  { id: 'id', label: 'PID', width: 64, align: 'end' },
  { id: 'cpu', label: 'CPU %', width: 72, align: 'end' },
  { id: 'command', label: 'Command' }, // unsized: takes the room
];

// --- several rungs up: generated logs, wrapped cells, multi-select --------

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

/** `n` entries with ids starting at `from`, so an append continues the
 *  numbering — the same generator serves the initial hundred thousand and
 *  every press of the tail button. */
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

const LEVEL_COLOR: Record<Entry['level'], string> = {
  info: '$textMuted',
  warn: '#e5a50a',
  error: '#e01b24',
};

function Logs({
  entries,
  tableRef,
}: {
  entries: readonly Entry[];
  tableRef: Ref<TableHandle<Entry>>;
}): ReactElement {
  const theme = useTheme();
  const [picked, setPicked] = useState<readonly TableRowId[]>([]);

  const columns = useMemo(
    (): TableColumn<Entry>[] => [
      {
        id: 'level',
        label: '',
        width: 28,
        sortable: false,
        render: (e) => (
          <Icon name="dot" size={8} color={LEVEL_COLOR[e.level]} />
        ),
      },
      { id: 'source', label: 'Source', width: 96 },
      {
        id: 'message',
        label: 'Message',
        // The rung the height model exists for: the text wraps, the row
        // grows, and the height index measures what it became.
        render: (e, state) => (
          <text style={{ color: state.color }}>{e.message}</text>
        ),
      },
    ],
    [],
  );

  return (
    <box style={{ flexGrow: 1, minHeight: 0 }}>
      <Table<Entry>
        ref={tableRef}
        rows={entries}
        columns={columns}
        selectionMode="multiple"
        selected={picked}
        onSelectedChange={setPicked}
        defaultSort={{ column: 'source', direction: 'asc' }}
        styles={{
          row: (s) =>
            !s.selected &&
            s.index % 2 === 1 && { backgroundColor: theme.surfaceHover },
        }}
        aria-label="Log entries"
        data-testname="logs"
        style={{ flexGrow: 1, minHeight: 0 }}
      />
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
          {picked.length
            ? `${picked.length} of ${entries.length} selected — Shift and Ctrl work the file-manager way`
            : `${entries.length} rows, every one its own height — Ctrl+A to select them all`}
        </text>
      </box>
    </box>
  );
}

// --- the window ------------------------------------------------------------

function App(): ReactElement {
  const processes = useMemo(listProcesses, []);
  const [entries, setEntries] = useState<Entry[]>(() => makeEntries(100_000));
  const logs = useRef<TableHandle<Entry>>(null);
  /** Set by the tail button, so the reveal follows the commit that grew the
   *  rows — the append-then-scroll a log viewer does on every batch. */
  const tail = useRef(false);
  useEffect(() => {
    if (!tail.current) return;
    tail.current = false;
    const last = entries[entries.length - 1];
    if (last) logs.current?.scrollToRow(last.id);
  }, [entries]);
  return (
    <window title="Table — the ladder" style={{ width: 980, height: 560 }}>
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
            tail.current = true;
            setEntries((prev) => [...prev, ...makeEntries(500, prev.length)]);
          }}
        />
        <text style={{ fontSize: 11, color: '$textMuted' }}>
          the live-tail shape: a batch arrives, the newest row is revealed
        </text>
      </box>
      <SplitPane defaultSize={340} style={{ flexGrow: 1, minHeight: 0 }}>
        <box style={{ flexGrow: 1, minHeight: 0 }}>
          {/* the whole left pane is this one element */}
          <Table<Proc>
            rows={processes}
            columns={PROC_COLUMNS}
            defaultSort={{ column: 'cpu', direction: 'desc' }}
            rowHeight={22}
            aria-label="Processes"
            data-testname="processes"
            style={{ flexGrow: 1, minHeight: 0 }}
          />
        </box>
        <Logs entries={entries} tableRef={logs} />
      </SplitPane>
    </window>
  );
}

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
