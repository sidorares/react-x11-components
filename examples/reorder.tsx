// Run with: npm run examples:reorder   (needs an X server / DISPLAY)
//
// A `<ReorderList>` is composition over core's drag and drop, so everything
// interesting about it is what each rung of the ladder adds. Four panes:
//
//  - a todo list — the shortest thing that works, the keyboard model on it
//    (Tab to an item, Space, the arrows, Space; Escape puts it back), a
//    selection several rows wide that travels as one, and a status line fed
//    by the list's own onDragStart/onDragUpdate/onDragEnd;
//  - cards with a grip: a `<ReorderHandle>` is the only press target, so
//    the button in each card keeps working, one card is `disabled`, and the
//    detail line reads the drag through `useReorderItem()`;
//  - a board: three columns sharing `group="board"`, one state object,
//    `onInsert` on the column it landed in and `onRemove` on the one it
//    left, and a `canDrop` on Done that takes no more than three;
//  - a palette whose items are copied rather than moved, dropped onto a
//    list that merges what lands in the middle of one of its items. Its
//    tags are chips with a ground and a radius of their own, and the ghost
//    is the chip: nothing here says how to draw the dragged one, because
//    the default is the item's own look at the item's own size;
//  - an inbox that takes files and text dropped from the desktop
//    (`accept` + `onDrop`), and whose items offer `text/plain` so they can be
//    dragged *out* — into a terminal, an editor, or the todo list's window;
//    its items are function children, and turn red over anything that
//    would not take them.
import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button, createRoot } from 'react-x11';

import {
  ReorderHandle,
  ReorderItem,
  ReorderList,
  arrayMove,
  useReorderItem,
} from '../src/index.js';
import type {
  ReorderDragUpdate,
  ReorderId,
  ReorderInsert,
} from '../src/index.js';

function Caption({ children }: { children: ReactNode }): ReactElement {
  return (
    <text style={{ fontSize: 12, fontWeight: 'bold', color: '$textMuted' }}>
      {children}
    </text>
  );
}

const row = {
  padding: 8,
  paddingLeft: 10,
  paddingRight: 10,
  borderWidth: 1,
  borderColor: '$border',
  borderRadius: 6,
  backgroundColor: '$surface',
} as const;

// --- rung 1: a list of strings ------------------------------------------------

interface Todo {
  id: number;
  title: string;
}

const TODOS: Todo[] = [
  'Buy milk',
  'Write the release notes',
  'Book the dentist',
  'Water the plants',
  'Call the bank',
].map((title, id) => ({ id, title }));

function Todos(): ReactElement {
  const [todos, setTodos] = useState(TODOS);
  const [selected, setSelected] = useState<ReorderId[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  const toggle = (id: number): void =>
    setSelected((chosen) =>
      chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id],
    );

  return (
    <box style={{ gap: 8, width: 240 }}>
      <Caption>A LIST</Caption>
      <ReorderList
        selected={selected}
        onReorder={(e) => {
          // the whole selection travels: `e.items` is the new order of ids
          const by = new Map(todos.map((t) => [t.id, t]));
          setTodos(e.items.map((id) => by.get(id as number)!));
        }}
        // the gesture, as the list sees it — what a toolbar or a bin would
        // listen to
        onDragStart={(e) =>
          setStatus(
            `holding ${e.ids.length} ${e.ids.length === 1 ? 'row' : 'rows'} from ${e.index + 1}`,
          )
        }
        onDragUpdate={(e: ReorderDragUpdate) =>
          setStatus(
            e.over ? `would land at ${e.over.index + 1}` : 'not over the list',
          )
        }
        onDragEnd={(e) =>
          setStatus(e.reason === 'drop' ? null : 'put back where it was')
        }
        style={{ gap: 4 }}
      >
        {todos.map((todo) => (
          <ReorderItem
            key={todo.id}
            id={todo.id}
            style={
              selected.includes(todo.id)
                ? [row, { borderColor: '$accent' }]
                : row
            }
          >
            <box
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
              onMouseDown={() => toggle(todo.id)}
            >
              <text
                style={{
                  color: selected.includes(todo.id) ? '$accent' : '$textMuted',
                }}
              >
                {selected.includes(todo.id) ? '◉' : '○'}
              </text>
              <text>{todo.title}</text>
            </box>
          </ReorderItem>
        ))}
      </ReorderList>
      <text style={{ fontSize: 11, color: '$textMuted' }}>
        {status ??
          'Drag a row, or Tab to one: Space lifts, arrows move, Escape cancels. Pick the dots to drag several.'}
      </text>
    </box>
  );
}

// --- rung 5: a palette that copies, into a list that merges -------------------

function Palette(): ReactElement {
  const [tags, setTags] = useState<string[]>([]);
  const [notes, setNotes] = useState([
    { id: 'n1', text: 'Ship the release', tags: [] as string[] },
    { id: 'n2', text: 'Book the room', tags: [] as string[] },
  ]);
  return (
    <box style={{ gap: 8, width: 260 }}>
      <Caption>COPY OUT, MERGE IN</Caption>
      <ReorderList
        id="tags"
        group="tags"
        orientation="horizontal"
        onReorder={(e) => setTags(e.items as string[])}
        style={{ gap: 6, flexWrap: 'wrap' }}
      >
        {['urgent', 'later', 'blocked'].map((tag) => (
          <ReorderItem
            key={tag}
            id={tag}
            // a palette hands out copies: the tag stays here
            dragActions={['copy']}
            style={{
              paddingLeft: 8,
              paddingRight: 8,
              paddingTop: 3,
              paddingBottom: 3,
              borderRadius: 10,
              backgroundColor: '$track',
            }}
          >
            <text style={{ fontSize: 11 }}>{tag}</text>
          </ReorderItem>
        ))}
      </ReorderList>
      <ReorderList
        id="notes"
        group="tags"
        combine
        onReorder={(e) => {
          const by = new Map(notes.map((n) => [n.id, n]));
          setNotes(e.items.map((id) => by.get(String(id))!).filter(Boolean));
        }}
        // dropped onto a note rather than between two: the tag joins it
        onCombine={(e) =>
          setNotes((list) =>
            list.map((n) =>
              n.id === e.into && !n.tags.includes(String(e.id))
                ? { ...n, tags: [...n.tags, String(e.id)] }
                : n,
            ),
          )
        }
        // a tag dropped *between* two notes is not a note; only notes reorder
        canDrop={(q) => q.source?.list === 'notes' || q.combine !== null}
        style={{ gap: 4 }}
      >
        {notes.map((note) => (
          <ReorderItem key={note.id} id={note.id} style={row}>
            <box style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <text style={{ flexGrow: 1 }}>{note.text}</text>
              {note.tags.map((tag) => (
                <text key={tag} style={{ fontSize: 10, color: '$accent' }}>
                  {tag}
                </text>
              ))}
            </box>
          </ReorderItem>
        ))}
      </ReorderList>
      <text style={{ fontSize: 11, color: '$textMuted' }}>
        {tags.length ? '' : 'Drop a tag on the middle of a note to tag it.'}
      </text>
    </box>
  );
}

// --- rung 2: cards with a grip -----------------------------------------------

interface Card {
  id: string;
  title: string;
  detail: string;
  locked?: boolean;
}

const CARDS: Card[] = [
  { id: 'mail', title: 'Mail', detail: '3 unread' },
  { id: 'calendar', title: 'Calendar', detail: 'Standup at 10:00' },
  { id: 'weather', title: 'Weather', detail: '14° and clearing' },
  { id: 'clock', title: 'Clock', detail: 'Pinned', locked: true },
];

/** The line under a card's title, reading the drag through the hook: what
 *  the card is doing beats what it says, while it is doing something. */
function CardDetail({ card }: { card: Card }): ReactElement {
  const { dragging, lifted, accepted, preview } = useReorderItem();
  const text = preview
    ? '…'
    : lifted
      ? 'Lifted — arrows move it, Space drops it'
      : dragging
        ? accepted
          ? 'Drop to move'
          : 'Nothing here will take it'
        : card.locked
          ? 'Pinned — will not move'
          : card.detail;
  return (
    <text
      style={{
        fontSize: 11,
        color: dragging && !accepted ? '$danger' : '$textMuted',
      }}
    >
      {text}
    </text>
  );
}

function Cards(): ReactElement {
  const [cards, setCards] = useState(CARDS);
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <box style={{ gap: 8, width: 260 }}>
      <Caption>A GRIP, AND A CONTROL BESIDE IT</Caption>
      <ReorderList
        onReorder={(e) => setCards((list) => arrayMove(list, e.from, e.to))}
        style={{ gap: 6 }}
      >
        {cards.map((card) => (
          <ReorderItem
            key={card.id}
            id={card.id}
            disabled={card.locked}
            aria-label={card.title}
            style={{
              ...row,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <ReorderHandle />
            <box style={{ flexGrow: 1, gap: 2 }}>
              <text style={{ fontWeight: 'bold' }}>{card.title}</text>
              <CardDetail card={card} />
            </box>
            <Button label="Open" onPress={() => setOpened(card.title)} />
          </ReorderItem>
        ))}
      </ReorderList>
      <text style={{ fontSize: 11, color: '$textMuted' }}>
        {opened
          ? `Opened ${opened}.`
          : 'The button is a button; only the grip drags.'}
      </text>
    </box>
  );
}

// --- rung 3: a board ---------------------------------------------------------

type Column = 'todo' | 'doing' | 'done';

const COLUMNS: { id: Column; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'Doing' },
  { id: 'done', label: 'Done' },
];

const BOARD: Record<Column, string[]> = {
  todo: ['Design review', 'Write tests', 'Update docs'],
  doing: ['Fix the flaky build'],
  done: ['Ship 0.4.0'],
};

function Board(): ReactElement {
  const [board, setBoard] = useState(BOARD);
  const splice = (
    column: Column,
    fn: (cards: readonly string[]) => string[],
  ): void => setBoard((prev) => ({ ...prev, [column]: fn(prev[column]) }));

  return (
    <box style={{ gap: 8 }}>
      <Caption>A BOARD — THREE LISTS IN ONE GROUP</Caption>
      <box style={{ flexDirection: 'row', gap: 12 }}>
        {COLUMNS.map((column) => (
          <box key={column.id} style={{ gap: 6, width: 150 }}>
            <text style={{ fontSize: 11, color: '$textMuted' }}>
              {column.label} · {board[column.id].length}
              {column.id === 'done' && board.done.length >= 3 ? ' (full)' : ''}
            </text>
            <ReorderList
              id={column.id}
              group="board"
              // Done is full at three: the last word on a drop, asked per
              // pointer position, so the column simply never lights up
              canDrop={(q) =>
                column.id !== 'done' ||
                q.source?.list === 'done' ||
                board.done.length < 3
              }
              onReorder={(e) =>
                splice(column.id, (cards) => arrayMove(cards, e.from, e.to))
              }
              // an item landed here from another column: put it in
              onInsert={(e) =>
                splice(column.id, (cards) => {
                  const next = cards.slice();
                  next.splice(e.index, 0, String(e.id));
                  return next;
                })
              }
              // an item left for another column: take it out
              onRemove={(e) =>
                splice(column.id, (cards) => cards.filter((c) => c !== e.id))
              }
              style={{
                gap: 4,
                padding: 6,
                minHeight: 120,
                borderRadius: 6,
                backgroundColor: '$track',
                ':drag-over': { backgroundColor: '$surfaceHover' },
              }}
            >
              {board[column.id].map((card) => (
                <ReorderItem key={card} id={card} style={row}>
                  <text style={{ fontSize: 12 }}>{card}</text>
                </ReorderItem>
              ))}
            </ReorderList>
          </box>
        ))}
      </box>
    </box>
  );
}

// --- rung 4: in from the desktop, out to it -----------------------------------

interface Note {
  id: ReorderId;
  text: string;
  path?: string;
}

function Inbox(): ReactElement {
  const [notes, setNotes] = useState<Note[]>([
    { id: 'n1', text: 'Drop a file or some text on me' },
    { id: 'n2', text: 'Drag me into a terminal' },
  ]);
  const [seq, setSeq] = useState(0);
  return (
    <box style={{ gap: 8, width: 260 }}>
      <Caption>IN FROM THE DESKTOP, OUT TO IT</Caption>
      <ReorderList
        accept={['files', 'text']}
        onReorder={(e) => setNotes((list) => arrayMove(list, e.from, e.to))}
        onInsert={(e: ReorderInsert) => void e.action}
        onDrop={(d) => {
          const arrived: Note[] = d.event.files.length
            ? d.event.files.map((f, i) => ({
                id: `f${seq + i}`,
                text: f.path ?? f.uri,
                path: f.path,
              }))
            : [{ id: `t${seq}`, text: d.event.text ?? '' }];
          setSeq(seq + arrived.length);
          setNotes((list) => [
            ...list.slice(0, d.index),
            ...arrived,
            ...list.slice(d.index),
          ]);
        }}
        style={{
          gap: 4,
          padding: 6,
          minHeight: 80,
          borderWidth: 1,
          borderColor: '$border',
          borderRadius: 6,
          ':drag-over': { borderColor: '$accent' },
        }}
      >
        {notes.map((note) => (
          <ReorderItem
            key={note.id}
            id={note.id}
            // offered beside the reorder payload, so a terminal or an editor
            // can take the note — and a file manager the file it came from
            dragData={{
              'text/plain': note.text,
              ...(note.path && {
                'text/uri-list': () => `file://${encodeURI(note.path!)}\r\n`,
              }),
            }}
            dragActions={['copy', 'move']}
            style={row}
          >
            {(state) => (
              <text
                style={{
                  fontSize: 12,
                  textWrap: 'nowrap',
                  textOverflow: 'ellipsis',
                  color:
                    state.dragging && !state.accepted ? '$danger' : '$text',
                }}
              >
                {note.text}
              </text>
            )}
          </ReorderItem>
        ))}
      </ReorderList>
    </box>
  );
}

function App(): ReactElement {
  return (
    <window title="ReorderList" width={1180} height={640}>
      <box style={{ flexDirection: 'row', gap: 28, padding: 20 }}>
        <box style={{ gap: 28 }}>
          <Todos />
          <Inbox />
        </box>
        <box style={{ gap: 28 }}>
          <Cards />
          <Palette />
        </box>
        <Board />
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
