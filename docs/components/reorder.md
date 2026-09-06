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

| Prop            | Type                                            | Notes                                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onReorder`     | `(change: ReorderChange) => void`               | An item moved within this list. `change.items` is the ids in their new order; `from`/`to` are what `arrayMove` takes.                                                                                                                  |
| `orientation`   | `'vertical' \| 'horizontal'`                    | Which way the items run: the indicator's edge, the arrow keys, and the root's `flexDirection`. Default `'vertical'`.                                                                                                                   |
| `group`         | `string`                                        | Lists sharing a group accept each other's items. Without one a list takes only its own.                                                                                                                                                |
| `id`            | `string`                                        | Names this list in the events other lists receive — `source.list` on an insert, `to.list` on a removal.                                                                                                                                |
| `onInsert`      | `(change: ReorderInsert) => void`               | An item arrived from another list in the group, at `change.index`; `change.source` says where from.                                                                                                                                    |
| `onRemove`      | `(change: ReorderRemove) => void`               | An item of this list was moved elsewhere — another list (`change.to`), or `to: null`: a dropzone in the app, or another application.                                                                                                   |
| `onCombine`     | `(change: ReorderCombine) => void`              | A drop _onto_ one of this list's items rather than between two. Needs `combine`.                                                                                                                                                       |
| `combine`       | `boolean`                                       | Whether the middle of an item is a merge target rather than an edge. Default false.                                                                                                                                                    |
| `canDrop`       | `(query: ReorderDropQuery) => boolean`          | The last word on whether a drop lands here, asked per pointer position and again at the drop. It can only refuse.                                                                                                                      |
| `selected`      | `readonly ReorderId[]`                          | The ids a multi-drag picks up together. The app holds the selection.                                                                                                                                                                   |
| `onDragStart`   | `(ev: ReorderDragStart) => void`                | The drag started: a press past the threshold, or a keyboard lift.                                                                                                                                                                      |
| `onDragUpdate`  | `(ev: ReorderDragUpdate) => void`               | Where it would land now — one per pointer position that changed the answer, one per keyboard step.                                                                                                                                     |
| `onDragEnd`     | `(ev: ReorderDragEnd) => void`                  | The gesture is over, after the change events, however it ended.                                                                                                                                                                        |
| `accept`        | `DropAccept`                                    | Foreign payloads the list takes, in core's `dropAccept` vocabulary: `['files']`, `'text/plain'`, a predicate. Without it they are refused.                                                                                             |
| `onDrop`        | `(drop: ReorderDrop) => void`                   | A foreign payload landed at `drop.index`; `drop.event` is core's, with `files`, `text` and `getData` on it.                                                                                                                            |
| `preview`       | `boolean \| 'auto' \| 'popup' \| 'inline'`      | Where the ghost is drawn. `'auto'` (the default) is a `<popup>`, which follows the pointer out of the list and over other applications. `'inline'` draws it inside the list instead. `false` leaves only the cursor and the indicator. |
| `renderPreview` | `(state: ReorderItemState) => ReactNode`        | What the ghost shows. Default: the item's children again, on a card the item's size. The state has `preview` set.                                                                                                                      |
| `previewSize`   | `{ width, height }`, or a function of the state | How big the ghost is. Default: the item's own size.                                                                                                                                                                                    |
| `dropAnimation` | `boolean \| number`                             | Whether the drop flies home, and for how long (default 180ms). Off under the desktop's reduced motion whatever this says.                                                                                                              |
| `styles`        | `ReorderStyles`                                 | `item(state)`, `handle`, `indicator`, `preview` — merged over the defaults, under each part's own `style`.                                                                                                                             |
| `disabled`      | `boolean`                                       | Nothing drags, nothing lifts, nothing lands.                                                                                                                                                                                           |
| `style`         | `Style \| Style[]`                              | The root box — `gap`, padding, `overflow: 'scroll'` for a list that scrolls.                                                                                                                                                           |
| `data-testname` | `string`                                        | For `react-x11/test` queries.                                                                                                                                                                                                          |

### `<ReorderItem>`

| Prop                  | Type                                | Notes                                                                                                                                                    |
| --------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | `string \| number`                  | Required. What the events name the item by.                                                                                                              |
| `disabled`            | `boolean`                           | Not draggable and not liftable — but still a slot others land beside.                                                                                    |
| `dragData`            | core's `dragData`                   | Offered beside the reorder payload, for other targets in the app and for other applications: `{ 'text/plain': …, 'text/uri-list': () => … }`.            |
| `dragActions`         | `Array<'copy' \| 'move' \| 'link'>` | What the drag offers. Default `['move']`, which is what a reorder is.                                                                                    |
| `aria-label`          | `string`                            | What a screen reader calls the item. Default: the item's own text.                                                                                       |
| `dragFromInteractive` | `boolean`                           | Let a press on a control inside the item start a drag anyway. Off by default — see [A press on a control](#a-press-on-a-control-belongs-to-the-control). |
| `children`            | `ReactNode \| (state) => ReactNode` | The content — or a function of the item's state, for content that reacts to the drag. See [What an item can see](#what-an-item-can-see).                 |
| `children`            | `ReactNode \| (state) => ReactNode` | The content — or a function of the item's state, for content that reacts to the drag. See [What an item can see](#what-an-item-can-see).                 |

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
  ids: ReorderId[];
  from: number;
  to: number;
}
interface ReorderInsert {
  items: ReorderId[];
  id: ReorderId;
  ids: ReorderId[];
  index: number;
  action: 'move' | 'copy';
  source: { list: string | undefined; index: number };
  event: DropEvent;
}
interface ReorderRemove {
  items: ReorderId[];
  id: ReorderId;
  ids: ReorderId[];
  index: number;
  to: { list: string | undefined; index: number } | null;
  event: DragEndEvent;
}
interface ReorderCombine {
  id: ReorderId;
  ids: ReorderId[];
  into: ReorderId;
  index: number;
  source: { list: string | undefined; index: number };
  event: DropEvent;
}
interface ReorderDrop {
  index: number;
  event: DropEvent;
}

// the gesture itself, on the list the dragged item belongs to
interface ReorderDragStart {
  id: ReorderId;
  ids: ReorderId[];
  index: number;
  input: 'pointer' | 'keyboard';
}
interface ReorderDragUpdate {
  id: ReorderId;
  ids: ReorderId[];
  from: number;
  over: { list: string | undefined; index: number } | null;
  combine: ReorderId | null;
  input: 'pointer' | 'keyboard';
}
interface ReorderDragEnd {
  id: ReorderId;
  ids: ReorderId[];
  from: number;
  to: { list: string | undefined; index: number } | null;
  combine: ReorderId | null;
  reason: 'drop' | 'cancel';
  input: 'pointer' | 'keyboard';
}
```

`ids` is everything that moved: `[id]`, unless `selected` held the item and a
multi-drag picked the set up. Every `index` an event reports is the index the
item **lands at** — `onDragUpdate.over.index` says the same number
`onReorder.to` or `onInsert.index` will, not the raw gap under the pointer.

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

| Field       | When it is set                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `dragging`  | The pointer is holding this item, from the threshold to the release.                                                            |
| `lifted`    | The keyboard is holding it, from Space to the drop, Escape or blur.                                                             |
| `edge`      | `'before'` or `'after'`: this item is beside the slot a drag would land in. On one item at a time.                              |
| `accepted`  | While `dragging`: whatever is under the pointer would take it — a list in the group, a dropzone, another application.           |
| `combining` | A drop here would merge _into_ this item rather than land beside it — the list's `combine`, and the pointer in its middle band. |
| `ids`       | Everything travelling with this item: `[id]`, unless a multi-drag picked up a selection.                                        |
| `preview`   | This render is the ghost's copy of the item.                                                                                    |
| `disabled`  | The item's or the list's.                                                                                                       |

It reaches four places: `styles.item(state)` (the look), `children` when it
is a function (the content), `useReorderItem()` (a component deeper inside
the content), and `renderPreview(state)` (the ghost, with `preview` set).
The default ghost renders the children again with the same state and
`preview: true`, so a child that renders in both places can draw its
lighter version there.

What it costs: a pointer motion re-renders the item being held (its
`position` and `accepted` change) and the item whose `edge` changed — never
the list, never the others.

## The gesture, as the list sees it

`onReorder`, `onInsert` and `onRemove` say what happened. The three
lifecycle events say what is happening, and fire on the list the dragged
item belongs to, whichever list the pointer is over:

```jsx
<ReorderList
  onDragStart={(e) => setHolding(e.ids)}
  onDragUpdate={(e) => setHint(e.over ? `to ${e.over.index + 1}` : 'nowhere')}
  onDragEnd={() => setHolding([])}
>
```

They are what a bin, a toolbar or a "drop here to delete" strip listens to,
and they cover the keyboard as well as the pointer — `input` says which.
`onDragUpdate` fires only when the answer changes, so a pointer moving
within one slot is silent.

A list that has to react to _another_ list's drag — a column greying itself
out while something is held — reads the source list's `onDragStart` into
state and passes it down as an ordinary prop. There is no provider above the
lists, and this is why one is not needed.

## Refusing a drop

`group` and `accept` are what the list _takes_, matched as data with no React
in the loop. `canDrop` is the dynamic half, asked once per pointer position
and again at the drop:

```jsx
<ReorderList canDrop={(q) => q.source?.list === 'inbox' && cards.length < 3}>
```

A refusal clears the indicator, turns the source's `accepted` off — so its
ghost can show it — and, at the drop, refuses the payload. It can only
refuse: a list is still only offered drags its `group` or `accept` matched,
which is what keeps the declarative fast path fast.

## Copying instead of moving

`dragActions={['copy']}` on an item makes its list a palette. The list that
takes it gets `onInsert({ action: 'copy' })` and the source keeps its own
item — no `onRemove`. Give the copy a new id in your state; the one on the
event is the palette's.

A drop back into the item's _own_ list always reorders rather than
duplicates, whatever the action says: a list does not copy into itself.

## Merging instead of inserting

With `combine`, the middle half of an item is a merge target rather than an
edge, and a drop there fires `onCombine` instead of `onReorder`/`onInsert`:

```jsx
<ReorderList combine onCombine={(e) => addTag(e.into, e.id)}>
```

The item being merged into is outlined rather than given a line beside it,
and its state says `combining`. Nothing is reordered — a merge is the app's
own operation on two items — but the source still hears `onRemove` for a
cross-list merge, exactly as it would for a move. An item cannot merge into
itself, or into anything travelling with it.

## Several at once

`selected` is the ids a multi-drag carries. Dragging one of them takes the
whole set, in the list's own order; dragging anything else takes just that
item:

```jsx
<ReorderList selected={chosen} onReorder={(e) => setOrder(e.items)}>
```

The set lands as one run at the slot, the ghost wears a count badge, and
`ids` on every event is what moved. The keyboard does the same: a lifted
member steps the whole run past its next neighbour, rather than into the
middle of itself. The app owns the selection — this component never changes
it.

## A press on a control belongs to the control

Core arms a drag from the nearest draggable _ancestor_ of whatever was
pressed, so without help a press on a text field inside a card would drag the
card after 4px. An item watches what its press landed on and cancels the drag
at the threshold when that was a control: a `<textinput>`, a `<textarea>`, a
`<codeeditor>`, or anything with an interactive role — `button`, `checkbox`,
`radio`, `switch`, `slider`, `link`, `tab`, `option`, `combobox`, `textbox`,
`menuitem`, `spinbutton`, `scrollbar`, `searchbox`. The gesture then
continues as ordinary mouse events, which is what the control wanted.

`dragFromInteractive` turns it off for an item whose controls should drag it
anyway. A `<ReorderHandle>` makes the question moot: the grip is the only
press target either way.

## The drop flies home

On release, a copy of the item flies from where the pointer let go to where
the item landed, and then goes. `dropAnimation={false}` turns it off,
`dropAnimation={320}` slows it down, and the desktop's **reduced motion**
setting turns it off whatever the prop says.

The copy is a box inside the list with `pointerEvents: 'none'`, not the ghost
popup carried on past the drop. That is deliberate: a popup outlives the
gesture as a real window over the list, and a press landing inside the
animation's duration — a double-click, most obviously — would hit that window
instead of the list under it.

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

## Where the ghost is drawn

The ghost is a `<popup>`: a window of its own, so it follows the pointer out
of the list, out of the window, and over other applications. That is what
`'auto'` uses on both backends — on cocoa a react-x11 popup is a
non-activating panel above every other application's ordinary windows, so it
is what the desktop sees while the pointer is over the Finder.

| `preview`  | The ghost is                                                          |
| ---------- | --------------------------------------------------------------------- |
| `'auto'`   | a `<popup>`. The default, and what `true` means.                      |
| `'popup'`  | the same, said explicitly.                                            |
| `'inline'` | a box inside the list: one fewer window a drag, and the limits below. |
| `false`    | not drawn. The indicator and the cursor are the whole feedback.       |

`'inline'` is the opt-in for a list that would rather not open a window per
drag — a remote display, where a window costs round trips. It is the same
absolutely positioned box, with `pointerEvents: 'none'`, that the
[drop flight](#the-drop-flies-home) uses, and it accepts two limits a window
does not have. It cannot leave the window. And `zIndex` here sorts a node
among its **siblings**, with no stacking context to escape, so the item
carrying it is lifted over its neighbours and the list over _its_ neighbours,
which covers two lists that are siblings but not two lists in separate
wrappers.

The popup is `transparent`, because the card inside it is rounded: on an
opaque window the four corners the radius gives up show the window's own
ground rather than the desktop.

**Dragging in and out of other applications** is XDND on X11 and NSDragging
on cocoa. Files from the Finder arrive as `['files']`, which is what `accept`
already names.

> Needs react-x11 **2.8.1**, and both halves of that floor are real. Before
> 2.8.0 a drag on the cocoa backend had no visible subject at all: AppKit's
> tracking loop owns the thread, so nothing rendered in response to `onDrag`
> reached the screen ([#484](https://github.com/sidorares/react-x11/pull/484)).
> And before 2.8.1 a preview popup there registered itself as a dragging
> destination, so it took the drop meant for the list beneath it
> ([#488](https://github.com/sidorares/react-x11/issues/488)).

## Example

`npm run examples:reorder` renders a todo list, a list of cards with grips
and a button in each, a three-column board in one group, and an inbox that
takes files and text from the desktop and whose items can be dragged back
out into a terminal.
