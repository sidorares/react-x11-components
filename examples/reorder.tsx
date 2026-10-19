// Run with: npm run examples:reorder   (needs an X server / DISPLAY)
//
// A `<ReorderList>` is composition over core's drag and drop, so everything
// interesting about it is what each rung of the ladder adds. Four panes:
//
//  - a todo list — the shortest thing that works, the keyboard model on it
//    (Tab to an item, Space, the arrows, Space; Escape puts it back), a
//    selection several rows wide that travels as one, and a status line fed
//    by the list's own onDragStart/onDragUpdate/onDragEnd. It also draws the
//    drop **as a gap** rather than as a line: the rectangle the rows are
//    about to occupy, opened where they would land, with everything below it
//    sliding down to make the room real. `DropGap` below is the whole of it,
//    and it needs nothing from the component — see its comment;
//  - cards with a grip: a `<ReorderHandle>` is the only press target, so
//    the button in each card keeps working, one card is `disabled`, and the
//    detail line reads the drag through `useReorderItem()`;
//  - a board: three columns sharing `group="board"`, one state object,
//    `onInsert` on the column it landed in and `onRemove` on the one it
//    left, and a `canDrop` on Done that takes no more than three — the
//    column lights from `onDragUpdate`, which says where the card would
//    land, rather than from `:drag-over`, which is set under the pointer
//    whether or not the drop would be taken;
//  - a palette whose items are copied rather than moved, dropped onto a
//    list that merges what lands in the middle of one of its items. Its
//    tags are chips with a ground and a radius of their own, and the ghost
//    is the chip: nothing here says how to draw the dragged one, because
//    the default is the item's own look at the item's own size;
//  - an inbox that takes files and text dropped from the desktop
//    (`accept` + `onDrop`), and whose items offer `text/plain` so they can be
//    dragged *out* — into a terminal, an editor, or the todo list's window;
//    its items are function children, and turn red over anything that
//    would not take them. It keeps the default line: a drag from the desktop
//    belongs to no list, so no `onDragUpdate` reports it and a space opened
//    from one never opens.
import { useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button, createRoot } from 'react-x11';

import {
  ReorderHandle,
  ReorderItem,
  ReorderList,
  arrayMove,
  useReorderItem,
  type ReorderDragStart,
  type ReorderStyles,
} from '../src/reorder/index.js';
import type {
  ReorderDragUpdate,
  ReorderId,
  ReorderInsert,
} from '../src/reorder/index.js';

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

/**
 * What a row wears while it is the one being dragged: nothing at all.
 *
 * **The row leaves the flow and the gap takes its place**, so the list has
 * the same number of places in it throughout — the one that is travelling is
 * the space, rather than a row *and* a space that together make the list a
 * row longer than it will end up.
 *
 * It also settles what the slots either end of the gesture mean. Drag the
 * first row and the slot above it is where it already is; with the row out
 * of the flow there is nothing to special-case, because the gap simply *is*
 * where the row currently is and moving it is the whole preview.
 *
 * Not a `:dragging` style block: those may only change paint properties, and
 * every one of these reflows the tree. Which is the right rule — a hover
 * that relayouts is a bad idea — and it is why this is React state, handed
 * out by `useDropGap`.
 */
const collapsed = {
  height: 0,
  padding: 0,
  paddingLeft: 0,
  paddingRight: 0,
  borderWidth: 0,
  opacity: 0,
  transition: { height: 130, opacity: 130 },
} as const;

/**
 * …and what it wears while the drop is where it already is: **the row is the
 * slot**, keeping its own box and losing only its contents.
 *
 * The alternative — collapse the row and open a separate space beside it —
 * cannot land on the same pixels. Every slot is a sibling in the column, so
 * each contributes its share of the list's `gap` whether it is open or shut,
 * and a space rendered next to a collapsed row therefore starts a few pixels
 * off from where that row was: measured, six. Worse, a row at index k has
 * *two* slots that change nothing, k and k+1, so the space had two places to
 * be and drifted between them as the pointer crossed. Letting the row keep
 * its place answers both: there is one self slot, it is exactly where the
 * row is, and nothing has to move to make it.
 */
const asGap = {
  borderColor: '$accent',
  backgroundColor: '$surfaceHover',
  transition: { borderColor: 130, backgroundColor: 130 },
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

/** The space between rows. The row *height* is not written down: the drag
 *  says how tall the row it picked up is (`ReorderDragStart.size`), because
 *  a constant for it is wrong the moment the theme's font size moves, and a
 *  gap that is not exactly a row tall is a promise the drop does not keep. */
const LIST_GAP = 4;

/**
 * The space a drop would take, opened where the rows would land.
 *
 * The default look is a **line** in the gap between two items — one rectangle
 * per item answers "which side of this one", and it costs no layout. This
 * list asks the other question instead: *how much room* is about to be taken,
 * and where. So it draws the whole rectangle, and the rows below it move down
 * to make the room real.
 *
 * Two things make that work without touching the component:
 *
 *  - **A gap is an ordinary sibling.** `<ReorderItem>`s register themselves
 *    with the list from the tree, so a box between two of them is not an item
 *    and is not counted — it is just a box in the same column.
 *  - **`transition` animates the height**, and flex layout does the rest: the
 *    gap grows, the column reflows, and every row below slides down with it.
 *    Nothing is transformed and nothing is positioned by hand.
 *
 * It is always rendered, at zero height when closed, because a transition
 * moves a value that changes — a box that mounts already open has nothing to
 * animate from.
 */
function DropGap({
  rows,
  rowHeight,
  listGap,
}: {
  rows: number;
  rowHeight: number;
  listGap: number;
}): ReactElement {
  const open = rows > 0;
  return (
    <box
      style={{
        height: open ? rows * rowHeight + (rows - 1) * listGap : 0,
        borderRadius: 6,
        // Zero, not "one in a transparent colour": a closed gap is a sibling
        // in the column like any other, so a hairline it still owns is two
        // pixels of the list's height that nothing accounts for — and the
        // row height is derived from the spacing between rows, so those two
        // pixels end up in every slot.
        borderWidth: open ? 1 : 0,
        borderColor: open ? '$accent' : 'transparent',
        backgroundColor: open ? '$surfaceHover' : 'transparent',
        transition: { height: 130, borderColor: 130, backgroundColor: 130 },
      }}
    />
  );
}

/**
 * `DropGap` wired to a list: the state and the three handlers that drive it,
 * so every list that wants a space instead of a line is three lines rather
 * than thirty.
 *
 * The space is the height of the row being dragged, which the drag says
 * itself: `ReorderDragStart.size`, the row's box in logical pixels as it was
 * picked up. This used to be measured here, as the distance between the
 * first two rows' content boxes read off `abs` — and `abs` is in *device*
 * pixels, so on a Retina display every space was two rows tall. It also
 * needed two rows to measure, which a board column does not always have.
 *
 * `list` on the drop is for a **group**: `onDragUpdate` fires on the list the
 * dragged item belongs to, whichever list the pointer is over, so a board's
 * three columns share one of these and each renders the gap only when
 * `over.list` names it. A lone list has no id and matches `undefined`.
 */
function useDropGap(listGap: number): {
  start: (e: ReorderDragStart) => void;
  note: (e: ReorderDragUpdate) => void;
  clear: () => void;
  gap: (at: number, list?: string) => ReactElement;
  /** Whether the card would land in this list — what a board column lights
   *  up for, where `:drag-over` would light it under any drag at all. */
  over: (list: string) => boolean;
  styles: ReorderStyles;
} {
  const [drop, setDrop] = useState<{
    list: string | undefined;
    slot: number;
    rows: number;
    rowHeight: number;
    /** The drop is where the row already is, so the row *is* the slot and
     *  no separate space is opened beside it. */
    home: boolean;
  } | null>(null);
  /** The dragged row's height, held for the length of the gesture. */
  const held = useRef(0);
  /** Everything travelling: the row under the pointer, and the rest of a
   *  selection it was picked up with. Only the first is `dragging`, so the
   *  others are found by id — left in place, they made the list a row
   *  longer for every one of them, beside a space already opened for all. */
  const moving = useRef<ReorderId[]>([]);
  /** Where the row started, which is the one place its *own* gap belongs. */
  const home = useRef(0);
  return {
    start: (e: ReorderDragStart): void => {
      held.current = e.size.height;
      // Open it where the row already is: the space it leaves is the space
      // it is going to, and everything after this is that space moving.
      if (e.input !== 'pointer') return;
      moving.current = e.ids;
      home.current = e.index;
      setDrop({
        list: undefined,
        slot: e.index,
        rows: e.ids.length,
        rowHeight: held.current,
        home: true,
      });
    },
    note: (e: ReorderDragUpdate): void =>
      setDrop(
        // `slot`, not `index`: one is the gap the pointer is over and the
        // other is where the row ends up, and for a downward move inside one
        // list they differ by exactly one.
        //
        // Pointer only. The keyboard path is not a preview — Space lifts and
        // each arrow *moves* the row, reporting where it now is — so a gap
        // there would open beside a row that has already arrived. And not
        // while combining: a tag landing *on* a note takes no room.
        //
        // A settled drop is pinned to where the row started. A row at index
        // k has **two** slots that change nothing: k and k+1, the gaps
        // either side of it. With the row collapsed out of the flow those
        // two gaps are adjacent, a few pixels apart, so drifting across the
        // boundary between them moved the space a hair up or down and back
        // — one "self" slot appearing to be two, and neither of them where
        // the row actually is. They are one place, and this is it.
        e.over && e.input === 'pointer' && !e.combine
          ? {
              list: e.over.list,
              slot: e.over.settled ? home.current : e.over.slot,
              home: e.over.settled,
              rows: e.ids.length,
              rowHeight: held.current,
            }
          : null,
      ),
    clear: (): void => {
      moving.current = [];
      setDrop(null);
    },
    gap: (at: number, list?: string): ReactElement => (
      <DropGap
        key={`gap-${at}`}
        // …except at home, where the row is doing this job itself.
        rows={
          drop && !drop.home && drop.slot === at && drop.list === list
            ? drop.rows
            : 0
        }
        rowHeight={drop?.rowHeight ?? 0}
        listGap={listGap}
      />
    ),
    over: (list: string): boolean => drop?.list === list,
    styles: {
      // The line is what a gap replaces, so a list drawing one does not draw
      // the other. Only the line: the outline a merge is drawn with is the
      // same seam, and a tag dropped on a note still wants it — `height: 0`
      // for both squashed it into a bar along the note's top edge.
      indicator: (mark) => (mark.combining ? null : { height: 0 }),
      // …and the row itself leaves the flow while it travels.
      //
      // `!state.preview` is the whole reason this lives here rather than on
      // the item's own `style`: the ghost that follows the pointer is drawn
      // from that same style, so collapsing it there collapses the thing
      // being dragged as well — a drag with a cursor and nothing under it.
      // `styles.item` is asked separately for the row and for the ghost, and
      // only one of them is supposed to disappear.
      item: (state) => {
        if (state.preview) return null;
        if (!state.dragging) {
          return moving.current.includes(state.id) ? collapsed : null;
        }
        return drop?.home
          ? // Its own height, held: with the contents gone the box would
            // otherwise shrink to its padding, and everything below it
            // would slide up by the height of a line — the row's place is
            // supposed to be exactly the size of what travels.
            {
              ...asGap,
              height: drop.rows * held.current + (drop.rows - 1) * listGap,
            }
          : collapsed;
      },
    },
  };
}

function Todos(): ReactElement {
  const [todos, setTodos] = useState(TODOS);
  const [selected, setSelected] = useState<ReorderId[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const gaps = useDropGap(LIST_GAP);

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
        onDragStart={(e) => {
          setStatus(
            `holding ${e.ids.length} ${e.ids.length === 1 ? 'row' : 'rows'} from ${e.index + 1}`,
          );
          gaps.start(e);
        }}
        onDragUpdate={(e: ReorderDragUpdate) => {
          setStatus(
            !e.over
              ? 'not over the list'
              : e.over.settled
                ? // `index` for a settled drop is the slot, not a place the
                  // row would move to — saying "would land at 4" about a row
                  // that would stay third is worse than saying nothing.
                  'would stay where it is'
                : `would land at ${e.over.index + 1}`,
          );
          // …and the same answer as a size instead of a position.
          gaps.note(e);
        }}
        onDragEnd={(e) => {
          setStatus(e.reason === 'drop' ? null : 'put back where it was');
          gaps.clear();
        }}
        styles={gaps.styles}
        style={{ gap: LIST_GAP }}
      >
        {todos.flatMap((todo, at) => [
          gaps.gap(at),
          <ReorderItem
            key={todo.id}
            id={todo.id}
            style={
              selected.includes(todo.id)
                ? [row, { borderColor: '$accent' }]
                : row
            }
          >
            {/* Empty while this row *is* the slot: the contents are in the
                ghost under the pointer, and a slot with a row still in it is
                not a slot. `preview` is what tells the two copies apart. */}
            {(state) =>
              state.dragging && !state.preview ? null : (
                <box
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  {/* A click, not a press: a press is also how a drag of
                      the row begins, so picking on the way down picked
                      every row a drag started on — and the next drag
                      carried both. A press that becomes a drag is never a
                      click. */}
                  <text
                    onClick={() => toggle(todo.id)}
                    style={{
                      color: selected.includes(todo.id)
                        ? '$accent'
                        : '$textMuted',
                    }}
                  >
                    {selected.includes(todo.id) ? '◉' : '○'}
                  </text>
                  <text>{todo.title}</text>
                </box>
              )
            }
          </ReorderItem>,
        ])}
        {/* the slot past the last row, which no item's edge can stand for */}
        {gaps.gap(todos.length)}
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
  const [tags, setTags] = useState(['urgent', 'later', 'blocked']);
  // Only the notes get a space. The palette above is a horizontal wrap and
  // hands out copies rather than moving anything, and a gap that opens
  // downwards would be answering a question nobody asked there.
  const gaps = useDropGap(LIST_GAP);
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
        {tags.map((tag) => (
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
        // …and a tag landing *on* a note takes no room, so `useDropGap` opens
        // nothing while the answer is a combine
        onDragStart={gaps.start}
        onDragUpdate={gaps.note}
        onDragEnd={gaps.clear}
        styles={gaps.styles}
        style={{ gap: 4 }}
      >
        {notes.flatMap((note, at) => [
          gaps.gap(at, 'notes'),
          <ReorderItem key={note.id} id={note.id} style={row}>
            {(state) =>
              state.dragging && !state.preview ? null : (
                <box
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                >
                  <text style={{ flexGrow: 1 }}>{note.text}</text>
                  {note.tags.map((tag) => (
                    <text key={tag} style={{ fontSize: 10, color: '$accent' }}>
                      {tag}
                    </text>
                  ))}
                </box>
              )
            }
          </ReorderItem>,
        ])}
        {gaps.gap(notes.length, 'notes')}
      </ReorderList>
      <text style={{ fontSize: 11, color: '$textMuted' }}>
        Drop a tag on the middle of a note to tag it.
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
  const gaps = useDropGap(6);
  return (
    <box style={{ gap: 8, width: 260 }}>
      <Caption>A GRIP, AND A CONTROL BESIDE IT</Caption>
      <ReorderList
        onReorder={(e) => setCards((list) => arrayMove(list, e.from, e.to))}
        onDragStart={gaps.start}
        onDragUpdate={gaps.note}
        onDragEnd={gaps.clear}
        styles={gaps.styles}
        style={{ gap: 6 }}
      >
        {cards.flatMap((card, at) => [
          gaps.gap(at),
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
            {(state) =>
              state.dragging && !state.preview ? null : (
                <>
                  {/* The grip goes with the rest while the card is the gap:
                      the drag's source is the card, so it may. */}
                  <ReorderHandle />
                  <box style={{ flexGrow: 1, gap: 2 }}>
                    <text style={{ fontWeight: 'bold' }}>{card.title}</text>
                    <CardDetail card={card} />
                  </box>
                  <Button label="Open" onPress={() => setOpened(card.title)} />
                </>
              )
            }
          </ReorderItem>,
        ])}
        {gaps.gap(cards.length)}
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
  // One for the group, not one per column: `onDragUpdate` fires on the list
  // the card belongs to, whichever column the pointer is over, so the column
  // that has to open a space is generally not the one being told.
  const gaps = useDropGap(LIST_GAP);
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
              // pointer position, so the column never lights up — a refusal
              // is reported as `over: null`, which `gaps.over` reads
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
              onDragStart={gaps.start}
              onDragUpdate={gaps.note}
              onDragEnd={gaps.clear}
              styles={gaps.styles}
              style={{
                gap: 4,
                padding: 6,
                minHeight: 120,
                borderRadius: 6,
                backgroundColor: gaps.over(column.id)
                  ? '$surfaceHover'
                  : '$track',
              }}
            >
              {board[column.id].flatMap((card, at) => [
                gaps.gap(at, column.id),
                <ReorderItem key={card} id={card} style={row}>
                  {(state) =>
                    state.dragging && !state.preview ? null : (
                      <text style={{ fontSize: 12 }}>{card}</text>
                    )
                  }
                </ReorderItem>,
              ])}
              {gaps.gap(board[column.id].length, column.id)}
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
        // The default line, not a space: a drag from the desktop belongs to
        // no list, so no `onDragUpdate` would say where to open one, and the
        // line is drawn for any drop the list would take — its own notes,
        // a file, some text — and for nothing else. Not `:drag-over` either,
        // which a row from the todo list would light on its way past.
        style={{
          gap: 4,
          padding: 6,
          minHeight: 80,
          borderWidth: 1,
          borderColor: '$border',
          borderRadius: 6,
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
