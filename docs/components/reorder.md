# ReorderList

```jsx
import {
  ReorderList,
  ReorderItem,
  arrayMove,
} from '@react-x11/components/reorder';

<ReorderList
  onReorder={(e) => setTodos((list) => arrayMove(list, e.from, e.to))}
>
  {todos.map((todo) => (
    <ReorderItem key={todo.id} id={todo.id}>
      <text>{todo.title}</text>
    </ReorderItem>
  ))}
</ReorderList>;
```

A list the user reorders by dragging its items, or by lifting one from the
keyboard and walking it with the arrows: a todo list, a playlist, the
columns of a settings dialog — and a kanban board, when several lists share
a `group`.

It is the **sortable layer over react-x11's own drag and drop**, the
position `@dnd-kit/sortable` holds over `@dnd-kit/core`, with the engine
being core's: the 4px threshold that keeps a press a click, `:dragging` and
`:drag-over`, the payload arriving by reference, auto-scroll near the edges
of a scrolling list, the `<popup dragPreview>` the ghost is drawn in, and
the promotion of the same drag to XDND the moment the pointer leaves the
app — so an item can be dropped into a file manager without the list
knowing. The design record, including the survey of dnd-kit,
hello-pangea/dnd, pragmatic-drag-and-drop, React Aria and Framer's
`Reorder`, is [the PRD](../prd-reorder.md).

It registers **no host element**. A list is `<box>`, a `<popup>` while a
drag is up, and core's `<Icon>` for the grip; there is no side effect at
import time.

## Parts

| Part            | What it is                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `ReorderList`   | The root, and the only drop target. Reads the order from the tree it rendered; holds the keyboard's lift. |
| `ReorderItem`   | One item. Draggable by any part of itself, and a tab stop — unless a handle inside it takes both over.    |
| `ReorderHandle` | The grip. Rendering one inside an item is the whole opt-in; the default is two columns of core's dots.    |

Every part takes `style` (`Style | Style[]`) and `data-testname`.

## Props

### `<ReorderList>`

| Prop            | Type                                     | Notes                                                                                                                                      |
| --------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `onReorder`     | `(change: ReorderChange) => void`        | An item moved within this list. `change.items` is the ids in their new order; `from`/`to` are what `arrayMove` takes.                      |
| `orientation`   | `'vertical' \| 'horizontal'`             | Which way the items run: the indicator's edge, the arrow keys, and the root's `flexDirection`. Default `'vertical'`.                       |
| `group`         | `string`                                 | Lists sharing a group accept each other's items. Without one a list takes only its own.                                                    |
| `id`            | `string`                                 | Names this list in the events other lists receive — `source.list` on an insert, `to.list` on a removal.                                    |
| `onInsert`      | `(change: ReorderInsert) => void`        | An item arrived from another list in the group, at `change.index`; `change.source` says where from.                                        |
| `onRemove`      | `(change: ReorderRemove) => void`        | An item of this list was moved elsewhere — another list (`change.to`), or `to: null`: a dropzone in the app, or another application.       |
| `accept`        | `DropAccept`                             | Foreign payloads the list takes, in core's `dropAccept` vocabulary: `['files']`, `'text/plain'`, a predicate. Without it they are refused. |
| `onDrop`        | `(drop: ReorderDrop) => void`            | A foreign payload landed at `drop.index`; `drop.event` is core's, with `files`, `text` and `getData` on it.                                |
| `preview`       | `boolean`                                | Whether a ghost follows the pointer. Default true.                                                                                         |
| `renderPreview` | `(state: ReorderItemState) => ReactNode` | What the ghost shows. Default: the item's children again, on a card the item's size. The state has `preview` set.                          |
| `styles`        | `ReorderStyles`                          | `item(state)`, `handle`, `indicator`, `preview` — merged over the defaults, under each part's own `style`.                                 |
| `disabled`      | `boolean`                                | Nothing drags, nothing lifts, nothing lands.                                                                                               |
| `style`         | `Style \| Style[]`                       | The root box — `gap`, padding, `overflow: 'scroll'` for a list that scrolls.                                                               |
| `data-testname` | `string`                                 | For `react-x11/test` queries.                                                                                                              |

### `<ReorderItem>`

| Prop          | Type                                | Notes                                                                                                                                         |
| ------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | `string \| number`                  | Required. What the events name the item by.                                                                                                   |
| `disabled`    | `boolean`                           | Not draggable and not liftable — but still a slot others land beside.                                                                         |
| `dragData`    | core's `dragData`                   | Offered beside the reorder payload, for other targets in the app and for other applications: `{ 'text/plain': …, 'text/uri-list': () => … }`. |
| `dragActions` | `Array<'copy' \| 'move' \| 'link'>` | What the drag offers. Default `['move']`, which is what a reorder is.                                                                         |
| `aria-label`  | `string`                            | What a screen reader calls the item. Default: the item's own text.                                                                            |
| `children`    | `ReactNode \| (state) => ReactNode` | The content — or a function of the item's state, for content that reacts to the drag. See [What an item can see](#what-an-item-can-see).      |

### `<ReorderHandle>`

| Prop         | Type        | Notes                                                    |
| ------------ | ----------- | -------------------------------------------------------- |
| `aria-label` | `string`    | Default "Drag to reorder".                               |
| `children`   | `ReactNode` | Default: a grip of six dots, from core's affordance set. |

## The events

```ts
interface ReorderChange {
  items: ReorderId[];
  id: ReorderId;
  from: number;
  to: number;
}
interface ReorderInsert {
  items: ReorderId[];
  id: ReorderId;
  index: number;
  source: { list: string | undefined; index: number };
  event: DropEvent;
}
interface ReorderRemove {
  items: ReorderId[];
  id: ReorderId;
  index: number;
  to: { list: string | undefined; index: number } | null;
  event: DragEndEvent;
}
interface ReorderDrop {
  index: number;
  event: DropEvent;
}
```

`items` is always _this_ list's ids after the change — what an app holding
ids sets its state to. An app holding objects uses the indices:
`arrayMove(objects, e.from, e.to)`, `objects.splice(e.index, 0, …)`,
`objects.filter((o) => o.id !== e.id)`.

## One list, rung by rung

Every rung below is a small diff on the snippet at the top, and none of
them changes what the others do — the contract `docs/prd-reorder.md`
states.

**Drag by a grip, not the whole item.** Render a handle inside it; the item
stops being the press target and the tab stop, and the button beside it is
just a button:

```jsx
<ReorderItem key={card.id} id={card.id}>
  <ReorderHandle />
  <text>{card.title}</text>
  <Button label="Open" onPress={() => open(card)} />
</ReorderItem>
```

**A strip instead of a column.** `orientation="horizontal"` turns the
indicator, the arrow keys, and the root's flex direction; under RTL the
start edge is on the right, with nothing said.

**An item that stays put.** `disabled` on it. Others still land on either
side of it.

**A board.** `group` on every column, and two more handlers — each on the
list it is about, so a column's state is a column's business:

```jsx
<ReorderList
  id={column}
  group="board"
  onReorder={(e) => splice(column, (cards) => arrayMove(cards, e.from, e.to))}
  onInsert={(e) => splice(column, (cards) => cards.toSpliced(e.index, 0, e.id))}
  onRemove={(e) => splice(column, (cards) => cards.filter((c) => c !== e.id))}
>
```

One move between columns is `onInsert` on the column it landed in, then
`onRemove` on the one it left — in that order, because core fires the
target's `onDrop` before the source's `onDragEnd`, and both inside one
event turn, so the two state updates paint as one. Handle the move in
**one of the two** or in both halves as above; not the whole move in each.
`ReorderRemove.to` carries the destination for an app that prefers the
source side alone.

**Out to other apps, and other dropzones.** `dragData` on the item is
core's prop, thunks and all, and is offered beside the reorder payload.
`dragActions={['copy', 'move']}` lets the target choose; a `move` taken by
anything that is not a list in the group is reported through `onRemove`
with `to: null`.

```jsx
<ReorderItem
  id={file.id}
  dragData={{
    'text/plain': file.path,
    'text/uri-list': () => `file://${encodeURI(file.path)}\r\n`,
  }}
  dragActions={['copy', 'move']}
>
```

**In from the desktop.** `accept` is core's `dropAccept` vocabulary, group
names included; `onDrop` gets the slot:

```jsx
<ReorderList accept={['files', 'text']} onDrop={(d) => insertAt(d.index, d.event.files)}>
```

A list without `accept` refuses every drag that is not a list item — the
default a list should have, so a stray file never lands in a todo list.

**Content that reacts.** `children` may be a function of the item's state,
and a component deeper inside calls `useReorderItem()` for the same object
— see [What an item can see](#what-an-item-can-see):

```jsx
<ReorderItem id={note.id}>
  {(s) => (
    <text style={{ color: s.dragging && !s.accepted ? '$danger' : '$text' }}>
      {note.text}
    </text>
  )}
</ReorderItem>
```

**The ghost.** `renderPreview={(state) => …}` replaces what it shows;
`preview={false}` leaves only the cursor and the indicator.

**The look.** `styles.item(state)` sees `{ id, dragging, lifted, disabled,
edge }`; `styles.indicator` restyles the line; `styles.handle` the grip;
`styles.preview` the card. Each part's `style` merges last.

## What an item can see

Three layers, cheapest first.

**Repaint-only states, from core.** `':dragging'` is set on the drag
source — the item box, or its handle — from the threshold to the release;
`':drag-over'` on the node under the pointer and its ancestors, so the list
root and the item the pointer is over both wear it, whether or not the drop
would be taken. Both are style blocks: a repaint, no render, and a
`transition` on the property fades them.

```jsx
<ReorderItem
  id={id}
  style={{
    transition: { backgroundColor: 120 },
    ':dragging': { backgroundColor: '$surfaceHover' },
  }}
>
```

**The state object.** The list computes one per item, per render:

| Field      | When it is set                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `dragging` | The pointer is holding this item, from the threshold to the release.                                                  |
| `lifted`   | The keyboard is holding it, from Space to the drop, Escape or blur.                                                   |
| `edge`     | `'before'` or `'after'`: this item is beside the slot a drag would land in. On one item at a time.                    |
| `accepted` | While `dragging`: whatever is under the pointer would take it — a list in the group, a dropzone, another application. |
| `preview`  | This render is the ghost's copy of the item.                                                                          |
| `disabled` | The item's or the list's.                                                                                             |

It reaches four places: `styles.item(state)` (the look), `children` when it
is a function (the content), `useReorderItem()` (a component deeper inside
the content), and `renderPreview(state)` (the ghost, with `preview` set).
The default ghost renders the children again with the same state and
`preview: true`, so a child that renders in both places can draw its
lighter version there.

What it costs: a pointer motion re-renders the item being held (its
`position` and `accepted` change) and the item whose `edge` changed — never
the list, never the others.

## The list is the only drop target

Items are not dropzones. The root carries one `dropAccept`, reads every
item's box on each pointer position — `abs`, in device pixels, divided by
the node's scale once, so the drag is right on a retina panel — and finds
the **closest edge**: the item nearest the pointer, and which half of it
along the list's axis the pointer is in. That is a slot from `0` to `n`,
and the item at that edge is told to draw the indicator through a setter
of its own, so a pointer motion re-renders at most two items and never the
list. The rule is one pure function, `closestSlot`, exported with the model
so an app driving a list from outside does the same arithmetic.

A same-list drag over the item's own gap — its own slot, or the one after
it — draws nothing and, on release, fires nothing.

## The indicator, not the slide

hello-pangea and dnd-kit move the neighbours out of the way as the pointer
crosses them. Here they do not: this renderer has no transform, so a
displacement is a layout pass per item per crossing, and a line at the
closest edge answers the same question — where will this land? — for a
rectangle per item and no measurement. The indicator is a 2px `$accent`
box positioned absolutely on the item's edge (`top`/`bottom`, or the
logical `start`/`end` when horizontal), _inside_ the item so a scrolling
list carries it. The PRD records what a slide would cost and where it would
plug in if it is wanted.

## Membership is in the payload's type name

Every item offers one private type,
`application/x-react-x11-reorder;scope=…`, where the scope is the `group`
or the list's own id, and every list's `dropAccept` names the scope it
belongs to. That keeps "which lists take this item" a fact core answers
from data with no React in the loop — the property its drag and drop was
designed around. An app's `accept` widens the same `dropAccept`, so core's
own matching of `'files'`, `'text'` and `'uris'` applies to the foreign
half unchanged. `REORDER_TYPE` is exported for a dropzone of the app's own
that wants to take, or refuse, a list item by name.

## The preview is a fresh instance

The ghost is a `<popup dragPreview>` — a real window following the
pointer, which is how core says a preview is drawn: it can leave the list
and the window, and it costs a window move per motion rather than a layout
pass. It renders the item's `children` again at the item's measured size,
inside a card, with the press offset kept so it appears under the item
rather than jumping to the cursor. Because it is a second render of the
same elements, a control inside the item comes up in its initial state in
the ghost — a typed-into `<textinput>` shows empty there. That is the trade
dnd-kit's `DragOverlay` makes too; `renderPreview` is the answer when it
matters. A `<ReorderHandle>` rendered in the ghost draws its grip and does
nothing else.

## Keyboard

The item — or its handle — is a tab stop, so a list of ten items is ten
stops. That is hello-pangea's model rather than the Tree's and Table's
single stop with a cursor, and deliberately: an item here is arbitrary
content, often with controls of its own, and a card whose button cannot be
reached by Tab because the list ate the stop is worse than a longer tab
order.

| Key                                 | What it does                                                          |
| ----------------------------------- | --------------------------------------------------------------------- |
| `Space` / `Enter`                   | Lift the item; lift again to drop it.                                 |
| `Up` / `Down` (or `Left` / `Right`) | Lifted: move it one slot, firing `onReorder`. Not lifted: focus next. |
| `Home` / `End`, while lifted        | Move it to an end.                                                    |
| `Escape`, while lifted              | Put it back where it was — `onReorder` with that order.               |

Every step is announced through core's `announce()` — "Lifted Buy milk,
position 2 of 5", "Buy milk moved to position 3 of 5", "dropped",
"cancelled" — which is inert where no assistive technology is listening.
Focus leaving a lifted item drops it where it is. A pointer drag ends a
lift.

## Example

`npm run examples:reorder` renders a todo list, a list of cards with grips
and a button in each, a three-column board in one group, and an inbox that
takes files and text from the desktop and whose items can be dragged back
out into a terminal.
