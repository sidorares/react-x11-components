# PRD: `src/reorder/` — a drag-and-drop list, and the engine it does not bring

Status: implemented. This document is the design record — the prior-art
survey, what each library settled, and the decisions the component is built
on — the way `prd-table.md` is for the table. `docs/components/reorder.md`
is the reference.

## What it is

A list whose items the user reorders by dragging them, or by lifting one
from the keyboard and walking it with the arrows: a todo list, a playlist,
the columns of a settings dialog, a kanban board when several of them share
a `group`.

```tsx
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

That is the whole basic setup. It buys: a drag past a 4px threshold (a
press is still a click), a live preview following the pointer, an
insertion line where the drop will land, auto-scroll near the edges of a
scrolling list, a keyboard model with announcements for a screen reader, and
— because the drag rides react-x11's own drag-and-drop — an item that can
also be dropped into any `dropAccept` node in the app, or into a file
manager. Everything else is opt-in on the same two elements; there is no
second API to graduate to.

## The engine is core's, so this is the sortable layer

The question every drag-and-drop library answers first is where the drag
comes from — a pointer sensor, the HTML5 protocol, a synthetic event
system — and the answer here was settled before this component existed.
react-x11 speaks XDND in both directions and runs an **in-app transport**
over the same handlers
([docs/drag-and-drop.md](https://github.com/sidorares/react-x11/blob/master/docs/drag-and-drop.md)):

| the engine already does        | how                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------- |
| the gesture                    | `draggable`; 4px threshold; a completed drag suppresses the click             |
| the source's feedback          | `':dragging'` style state; `onDragStart` / `onDrag` / `onDragEnd`             |
| the target's feedback          | `':drag-over'` on the path under the pointer; `onDragEnter/Over/Leave`        |
| who takes the drop             | `dropAccept` — data, matched deepest-first, with no React in the loop         |
| the payload, in-app            | `dragData` values arrive **by reference** on `e.items`; thunks resolve lazily |
| the payload, out of the app    | the same drag promotes to XDND when the pointer leaves the app's windows      |
| what the drop did              | `e.accept('move')` on the target reaches the source's `onDragEnd`             |
| scrolling a list from the edge | any scroll container a drag rests near, 24px band, no opt-in                  |
| the preview                    | a `<popup dragPreview>` following `useDragSource().position` — a live tree    |
| testing                        | `fireEvent.mouseDown/mouseMove/mouseUp` through the in-process X server       |

So the package's first rule — build on the public API, and file a gap
rather than working around it — decides the shape: **this is the layer
`@dnd-kit/sortable` is over `@dnd-kit/core`, over an engine that is
core's.** What is left to write is exactly what a sortable preset is: the
insertion arithmetic, the indicator, the keyboard model, and an event
vocabulary that speaks list-and-index rather than node-and-pointer.

## Prior art, and what it settles

The survey behind this design started from
[Puck's "Top 5 drag-and-drop libraries for React"](https://puckeditor.com/blog/top-5-drag-and-drop-libraries-for-react)
— Puck, dnd-kit, hello-pangea/dnd, pragmatic-drag-and-drop, Gridstack — and
added the three the article leaves out that matter here:
[React Aria's `useDragAndDrop`](https://react-spectrum.adobe.com/react-aria/dnd.html),
[Framer Motion's `Reorder`](https://motion.dev/docs/react-reorder), and
[react-dnd](https://react-dnd.github.io/react-dnd/), which core's own
architecture note names as the ecosystem prize.

Each was read against one question — _what API would work well beside the
components already here?_ — which resolves to four house rules:

1. **Build on core, never beside it.** Core has the engine; a library that
   brought its own sensors or collision detection would be a second event
   system in the process, and would lose XDND.
2. **Ceremony is additive** (`prd-table.md`, "The continuity contract"). The
   basic list must be the bottom rung of the real thing, not a starter kit.
3. **The house grammar.** Compositions are Chakra-shaped with the parts
   spelled flat (`<Tabs>`/`<TabsTrigger>`, `<Timeline>`/`<TimelineItem>`);
   content that is arbitrary is _children_, not an items array; controlled
   events speak React Aria's dialect (`onReorder`, `onInsert`).
4. **No DOM-merging ceremony.** `asChild`, render props handing back
   `innerRef`/`draggableProps`, `attributes`/`listeners` spreads — all of it
   exists to attach behaviour to somebody else's DOM element. There is no
   DOM; the item _is_ the box.

### Puck, and Gridstack — the layers above and beside

**Puck** is a visual page editor: components registered through a config,
a JSON document out. It is what one would _build with_ a list like this,
the way Untitled UI is what one builds with a table, and it marks the layer
this component stays below. **Gridstack** is a dashboard grid — widgets
that pack into rows and columns, resize, and snap — with a jQuery-era
imperative DOM API. It is a different component (2D packing is not a list)
and a non-goal here. Both are recorded so the question is not reopened.

### dnd-kit — the right layer, the wrong displacement

dnd-kit is two packages: a core (`DndContext`, `useDraggable`,
`useDroppable`, sensors, collision-detection strategies, `DragOverlay`,
modifiers, auto-scroll) and a sortable preset (`SortableContext`,
`useSortable`, `arrayMove`, sorting strategies). The core half duplicates
what react-x11 already ships: its sensors are the threshold and capture,
its `DragOverlay` is `<popup dragPreview>`, its auto-scroll is the engine's
edge band, its collision detection is the hit test `dropAccept` runs on.

The **preset** is the shape taken: a context that knows the items and an
item that names itself by id — `<ReorderList>` and `<ReorderItem id>`.
Three things are deliberately not taken:

- **`transform`-based displacement.** dnd-kit moves the _other_ items out of
  the way with CSS transforms as the pointer crosses them. This renderer has
  no transform; every displacement would be a layout pass, and the item
  would still not glide. See "The indicator, not the slide" below.
- **The `items` array beside the children.** `SortableContext items={ids}`
  duplicates the order the children already are in. The list reads the
  order from the tree it rendered, so the caller writes it once.
- **`attributes` / `listeners` / `setNodeRef`.** They merge behaviour into a
  DOM element the caller owns. Here the item is the element.

`arrayMove` is taken by name: it is what every `onReorder` handler ends up
calling, and the name is the one people know.

### hello-pangea/dnd — the vocabulary, not the ceremony

hello-pangea (react-beautiful-dnd's maintained fork) is _strictly_ lists,
and its **event shape is the best one for that**: `onDragEnd({ source:
{ droppableId, index }, destination: { droppableId, index } })`. A reorder
is a list and two indices; a move between lists is two lists and two
indices; nothing about nodes or pointers. `ReorderChange.from`/`to` and
`ReorderInsert.source` are that vocabulary.

Its keyboard model is taken too, because it is what screen-reader users have
learnt from the web: Space lifts, the arrows move the lifted item, Space
drops, Escape puts it back, and every step is announced. Its component
ceremony is not — `<DragDropContext>`, `<Droppable>`'s render prop with
`provided.innerRef` and `placeholder`, `<Draggable index>` with
`dragHandleProps` — all of which exists to reach a DOM element and to keep
the DOM's own index in sync.

Its signature feature, the neighbours **sliding** out of the way, is the one
thing not carried over, and the reason is recorded below rather than left
as a gap.

### pragmatic-drag-and-drop — the closest analogue to core's own layer

Atlassian's library is headless and framework-agnostic over the browser's
native drag protocol: `draggable({ element, getInitialData })`,
`dropTargetForElements({ element, onDrop })`, `monitorForElements`. That is
_exactly_ the shape of react-x11's `draggable`/`dragData`/`dropAccept`
props — element-registered, native protocol underneath, auto-scroll in the
engine, the payload read by whoever monitors the drop. Reading it confirmed
the split rather than informing it.

What it settled is the **insertion model**. Its hitbox add-on attaches the
_closest edge_ of the target to the drag data — the pointer is nearer the
top or the bottom of the item it is over — and its `getReorderDestinationIndex`
turns that into an index. That model works for a vertical list, a
horizontal strip, and a wrapping grid alike, needs no measurement of
anything but the items' own rectangles, and is a pure function; it is
`src/reorder/model.ts`. Its feedback — a **drop-indicator line** at that
edge rather than a moving placeholder — is the honest feedback for a
renderer that cannot transform, and it is the default here.

### React Aria — the dialect this package already speaks

`useDragAndDrop` on Aria's list components is not in the article and is the
closest thing to a house style: `onReorder` for a move within the list,
`onInsert` when items arrive from elsewhere, `onRootDrop` for a drop on the
list itself, and on the source side `onDragEnd` — where the app removes the
items when `dropOperation === 'move'` and the drop was not internal. **A move
between two lists is two local handlers**, one on each list, and no
provider above them.

That is what is taken, with the removal made explicit rather than left to
the app: `onReorder`, `onInsert`, `onRemove` and `onDrop`, each a prop on
the list it is about. It is also what core's own events already say —
`onDrop` on the target, then `onDragEnd({ action, dropped })` on the source,
"always last" — so the layer adds vocabulary without adding sequencing.

Aria's `getItems` (serialised payloads per item, for the drag to leave the
component) is core's `dragData`, thunks and all, passed straight through
on `<ReorderItem>`.

### Framer Motion's `Reorder` — the bottom rung

`<Reorder.Group values onReorder>` and `<Reorder.Item value>` is the
shortest sortable list in the React ecosystem, and it is what the bottom
rung here has to be as easy as. It has no handles, no keyboard, no lists
that exchange items and no drop indicator, which is why it is the floor and
not the design.

### react-dnd — recorded, not pursued

Core's architecture note calls a react-x11 backend for react-dnd "the one
real prize": `dnd-core` is DOM-free and its backends are pluggable. A
backend is core's business, not this package's, and a sortable over
react-dnd would still need everything in this document. Nothing here
precludes it.

## Goals and non-goals

### Goals

- **One list is one element and one handler.** `<ReorderList onReorder>`
  around `<ReorderItem id>`s, and the shortest thing that works is four
  lines.
- **The engine's features come for free**, not re-implemented: threshold,
  click suppression, auto-scroll, the preview window, XDND out of the app.
- **Every rung is local** — a handle is a part inside the item, a board is
  `group` on the lists, a look is `styles`.
- **Keyboard and screen reader**, with the model people know from the web.
- **Correct at any display scale.** The insertion arithmetic is tested at
  `scale: 2`, per the package's standing rule.

### Non-goals

- **Virtualization.** A reorderable list of a hundred thousand rows is
  `<Table>`'s rung, later, on the same `model.ts`; a list is built whole.
- **A dashboard grid** (Gridstack's shape): 2D packing is another component.
- **Sliding neighbours.** Recorded below as rejected-for-now, with the door
  left open.
- **Modifier-key copy/move.** Core has no modifier negotiation during a
  drag; the requested action is fixed at start and only a target changes it.
  `dragActions={['copy']}` is the per-item answer instead.
- **Nested reorderable trees.** `<Tree>`'s rung, if it comes.
- **A second engine.** No sensors, no collision strategies. A gap in core's
  drag and drop is filed there.

## The continuity contract

| When a list needs…                       | …it adds                                            | and nothing else moves                                 |
| ---------------------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| items that reorder                       | `<ReorderList onReorder>` + `<ReorderItem id>`      | —                                                      |
| the app's own objects                    | nothing — `arrayMove(objects, e.from, e.to)`        | `e.items` is the ids, `e.from`/`e.to` are indices      |
| a grip instead of the whole item         | `<ReorderHandle>` inside the item                   | the item stops being the press target; keys move too   |
| a horizontal strip                       | `orientation="horizontal"`                          | the indicator turns, arrows turn, RTL mirrors          |
| an item that stays put                   | `disabled` on it                                    | it is still a slot others land beside                  |
| a board                                  | `group` on each list; `onInsert` + `onRemove`       | `onReorder` still handles the move within one list     |
| a target that refuses                    | `canDrop`                                           | `group`/`accept` still decide what is offered at all   |
| a palette                                | `dragActions={['copy']}` on the item                | the target reads `action`; the source keeps its item   |
| merging two items                        | `combine` + `onCombine`                             | edges still reorder; the middle is the only new answer |
| several at once                          | `selected` on the list                              | every event grows `ids`; the app owns the selection    |
| watching the gesture                     | `onDragStart` / `onDragUpdate` / `onDragEnd`        | the change events are unchanged                        |
| controls inside an item                  | nothing — a press on one is not a drag              | `dragFromInteractive` turns that off                   |
| naming the column in the events          | `id` on the list                                    | —                                                      |
| dropping items into other apps / targets | `dragData` (and `dragActions`) on the item          | the reorder payload is offered beside it               |
| taking files or text from outside        | `accept` + `onDrop` on the list                     | the list still refuses every other foreign drag        |
| content that reacts to the drag          | `children` as a function; `useReorderItem()` deeper | the state is the one `styles.item` already sees        |
| a different ghost, or none               | `renderPreview`, or `preview={false}`               | —                                                      |
| the look                                 | `styles.item/handle/indicator/preview`, `style`     | geometry and behaviour stay the list's                 |
| a name a screen reader can say           | `aria-label` on the item                            | otherwise the item's own text is read                  |

The same three rules `prd-table.md` states keep this honest: opt-ins are
orthogonal, escalation is local, and `docs/components/reorder.md` grows one
list through the rungs.

## Public API

```ts
type ReorderId = string | number;

interface ReorderListProps {
  /** Names this list in the events other lists receive. */
  id?: string;
  /** Lists sharing a group accept each other's items. */
  group?: string;
  orientation?: 'vertical' | 'horizontal'; // default 'vertical'
  disabled?: boolean;
  onReorder?: (change: ReorderChange) => void;
  onInsert?: (change: ReorderInsert) => void;
  onRemove?: (change: ReorderRemove) => void;
  /** Foreign payloads the list takes — core's `dropAccept` vocabulary. */
  accept?: DropAccept;
  onDrop?: (drop: ReorderDrop) => void;
  preview?: boolean; // default true
  renderPreview?: (state: ReorderItemState) => ReactNode;
  styles?: ReorderStyles;
  style?: Style | Style[];
  'data-testname'?: string;
  children?: ReactNode;
}

interface ReorderItemProps {
  id: ReorderId;
  disabled?: boolean;
  /** Offered beside the reorder payload — for other targets and other apps. */
  dragData?: DragSourceProps['dragData'];
  dragActions?: Array<'copy' | 'move' | 'link'>; // default ['move']
  'aria-label'?: string;
  style?: Style | Style[];
  'data-testname'?: string;
  children?: ReactNode | ((state: ReorderItemState) => ReactNode);
}

interface ReorderItemState {
  id: ReorderId;
  dragging: boolean; // the pointer holds it
  lifted: boolean; // the keyboard holds it
  disabled: boolean;
  edge: 'before' | 'after' | null; // beside the slot a drag would land in
  accepted: boolean; // while dragging: the thing under the pointer would take it
  preview: boolean; // this render is the ghost's copy
}
function useReorderItem(): ReorderItemState;

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
  /** Another list (its `id`, and where), or null: another application, or a plain dropzone. */
  to: { list: string | undefined; index: number } | null;
  event: DragEndEvent;
}
interface ReorderDrop {
  index: number;
  event: DropEvent;
}
```

`arrayMove(list, from, to)` comes out beside them, as does the model:
`closestSlot`, `moveToSlot`, `insertAtSlot`.

## Geometry: the closest edge

The list is the only drop target; items are not. Per pointer position the
root reads the items' rectangles — `abs`, in device pixels, divided by the
node's `scale` once — finds the item nearest the pointer (distance zero
when inside it), and asks which half of it, along the list's axis, the
pointer is in. Nearer the start edge is "before that item", nearer the end
is "after": a **slot** from `0` to `n`. The item nearest a point below the
last item is the last item, the pointer is past its middle, and the slot is
`n`; in a gap between two, the nearer one wins.

The rule is one pure function (`closestSlot`) over rectangles, so it is
asserted on no display, and it is the same rule for a vertical list, a
horizontal one, an RTL one (the start edge is on the right, and the node's
resolved `direction` says so) and a wrapping grid.

A same-list drag whose slot would change nothing — the item's own slot, or
the one after it — draws no indicator and, on release, fires no event.

## What an item can see

An item reacts on three layers, and the split is the cost model. Core's
`':dragging'` and `':drag-over'` style states are a repaint with no render,
so they are the default answer for a wash or a border. The state object —
`dragging`, `lifted`, `edge`, `accepted`, `preview`, `disabled` — reaches
`styles.item`, function `children`, `useReorderItem()` and `renderPreview`,
and it is computed by the item's own render, so a pointer motion re-renders
the held item (core's `useDragSource` hands it `position` and `accepted` per
motion) and the one item whose `edge` changed, never the list. `accepted` is
core's answer — the deepest matching `dropAccept` under the pointer — so a
ghost can say "not here" over the window background without the list
knowing what else is in the app. `preview` exists because the default ghost
is a second render of the same children: a child that renders in both
places gets to know which one it is.

## The indicator, not the slide

hello-pangea and dnd-kit move the neighbours out of the way as the pointer
crosses them. Here that would mean: absolutely position every item, measure
each one after layout (the tick `src/internal/timers.ts` exists for), and
re-lay-out the list on every crossing — with `transition` on `top` doing the
glide, which core does support. It is buildable. It is not built, because
the drop-indicator line answers the same question (where will this land?)
for a rectangle per item and no measurement, and because the renderer's own
`<Tabs>` already accepted "moves in one step rather than gliding" for its
indicator. If a slide comes back it is a rung — `slide` on the list — and
the model module does not change.

The indicator is a 2px `$accent` box absolutely positioned on the target
item's edge (`top`/`bottom`, or the logical `start`/`end` when horizontal,
so RTL costs nothing), inside the item so a scrolling list carries it.

## The preview

The ghost is a `<popup dragPreview>` — a real override-redirect window
following the pointer, which is how core says a preview is drawn: it can
leave the list, leave the window, and costs a window move per motion rather
than a layout pass. It shows the item's `children` again, at the item's
measured size, inside a surface with a border. **It is a fresh instance** —
a `<textinput>` in a card comes up empty in the ghost — which is dnd-kit's
`DragOverlay` trade too; `renderPreview` replaces the content, and
`preview={false}` leaves only the cursor. The grab offset is kept, so the
ghost appears exactly under the item rather than jumping to the cursor.

## One payload type, scoped

Every item offers one private type,
`application/x-react-x11-reorder;scope=<group, or the list's own id>`, and
every list's `dropAccept` names the scope it belongs to. That is what makes
"lists in a group take each other's items" a declarative fact core answers
with no React in the loop — the property the engine was designed around.
The value behind the type is a thunk, so the source index is read at the
drop; it resolves to a live object, and the target writes where the item
landed onto it, which is how the source's `onDragEnd` — which core fires
last, with `action` and `dropped` but no destination — can report `to`.

An app's `accept` widens the list's `dropAccept` (an array gains the scope;
a predicate is or-ed with it), so core's own group matching (`'files'`,
`'text'`, `'uris'`) applies to the foreign half unchanged. A drop whose
payload is not the live reorder object — another application offering the
same type name, say — is a foreign drop, and is refused unless `accept`
took it.

One engine fact shaped this and is worth keeping: `e.accept()` in
`onDragOver` can override a **matched** node's answer, but it cannot make
a node whose `dropAccept` said no into the target — the engine keeps the
accepting node, not the answer. So membership had to be in the type name,
where `dropAccept` can see it.

## Keyboard and announcements

The item — or its `<ReorderHandle>`, when it has one — is the focus target
and a tab stop, as hello-pangea's handles are. The Tree/Table model (one
tab stop, the container holds the cursor) is deliberately not used: an item
here is arbitrary content, often with controls of its own, and a card whose
button cannot be reached by Tab because the list ate the stop is worse than
a list of ten stops.

| Key                                 | What it does                                            |
| ----------------------------------- | ------------------------------------------------------- |
| `Space` / `Enter`                   | Lift the item; lift again to drop it.                   |
| arrows along the axis, while lifted | Move it one slot — `onReorder` fires per step.          |
| `Home` / `End`, while lifted        | Move it to an end.                                      |
| `Escape`, while lifted              | Put it back where it was — `onReorder` with that order. |
| arrows along the axis, not lifted   | Focus the neighbour.                                    |

Every step goes through `announce()` — "Lifted Buy milk, position 2 of 5",
"Moved to position 3 of 5", "Dropped", "Cancelled" — which is inert where no
assistive technology is listening. Blur while lifted drops in place.

## Theming

Nothing here has a colour of its own but the indicator (`$accent`) and the
preview's surface (`$surface`, `$border`, the theme's `radius`). A lifted or
dragging item takes a `$surfaceHover` wash — over the item's own `style`,
the way a `:hover` block sits over a base style, so a row painted
`$surface` still shows which one is held. Everything is a `$token` in a
style, so it follows the palette; `styles.item(state)` gets `{ id,
dragging, lifted, disabled, edge }` and merges last, over the wash.

## Testing and guards

- `test/reorder-model.test.ts` — the slot arithmetic, `arrayMove`, the
  no-op rule; no display.
- `test/reorder.test.ts` — on the in-process X server: a pointer drag past
  the threshold to a slot and the event it fires; the indicator's edge; a
  handle that is the only press target; a disabled item; a horizontal strip;
  the keyboard model end to end; two lists in a group exchanging an item
  (`onInsert` then `onRemove`, with `source` and `to`); a foreign drop taken
  through `accept` and refused without it; the preview window; the state
  function children and `useReorderItem()` see; and the drag at `scale: 2`.
  The second round added: the three lifecycle events for both inputs, a
  `canDrop` that refuses a list and one that refuses a slot, a copy palette,
  a merge and the outline it draws, a press on a button and on a field
  inside an item (and `dragFromInteractive` giving it back), a selection
  moving as one run within a list, between lists and from the keyboard,
  `previewSize`, the announcement a pointer drag makes, and the drop flight
  — that it is a box with `pointerEvents: 'none'` rather than a window, and
  that it goes.
- The cases the first cut never exercised, added with the second round: a
  **scrolling** list (the slot is read off where the rows are now), a list
  **nested** inside another list's item, a **board whose columns reorder**
  as well as its cards, a drop into an **empty** list, items **added
  mid-drag**, three hundred items as a smoke test for an accidental O(n²),
  and combine plus multi-drag at `scale: 2`.
- `test/types/reorder.tsx` compiles every rung.
- `test/treeshake.test.ts` — the payload type name is the marker.

## The second round: what the story survey found

The design above shipped, and was then measured against
[react-beautiful-dnd's storybook](https://react-beautiful-dnd.netlify.app) —
23 story files, read as the list of use cases a mature list library is
expected to serve. Most mapped onto what was already here (mixed sizes,
mixed spacing, a fixed sidebar, portals, function components, multiple
contexts, nested lists, lists in tables), and two are deliberate non-goals
that stay non-goals: **virtualization** (`<Table>`'s rung, over this same
model) and **window scrolling** (core auto-scrolls scroll containers, and a
desktop window is not a page).

Eight gaps were real, and all eight are closed. What each cost, and the
decision inside it:

1. **The gesture had no events.** `onDragStart`/`onDragUpdate`/`onDragEnd`
   on the source list — rbd's three, covering the keyboard as well.
2. **Acceptance was static.** `canDrop`, asked per position and again at the
   drop. It can only _refuse_, because core keeps the node whose
   `dropAccept` matched and lets a handler reject the position; the
   asymmetry is the engine's, and hiding it would mean re-implementing the
   matcher.
3. **Everything was a move.** The target forced `accept('move')`, so a
   palette lost its items. It honours the offered action now, and
   `onInsert` reports which it was.
4. **No merging.** `combine` puts a band in the middle of each item and
   `onCombine` reports a drop onto one. The model grew one optional
   argument and one boolean on its answer; the component draws an outline
   where the line would be.
5. **A press on a control dragged the card.** Fixed in the layer, because
   core arms from the nearest draggable ancestor by design: the item
   records what the press landed on and cancels at the threshold. rbd's
   `disableInteractiveElementBlocking` is `dragFromInteractive` here.
6. **One item at a time.** `selected` on the list; the set travels in list
   order and lands as one run, from the pointer or the keyboard. The
   keyboard step was the subtle half — `from + 1` lands a run inside
   itself, so a step moves the whole run past its next _non-member_.
7. **The ghost could not be sized, and a pointer drag said nothing.**
   `previewSize`, and `announce` for pointer drags as well as keyboard ones.
8. **The drop was instant.** `dropAnimation` flies a copy home.

### The hover channel is module state

`onDragOver` hands a target a `DragEvent`, and only `DropEvent` carries
`items` — so a target physically cannot write on the dragged payload while
the pointer is merely over it. Without a channel `onDragUpdate` could say
"somewhere else" but never _which list, at what index_.

The answer is one module-scope object per gesture: the list under the
pointer writes where a drop would land, the source reads it in its own
`onDrag` (core tells the target first, which its reference guarantees), and
it is null between gestures. Nothing reads it at import time, and a second
copy of the module would only mean two independent gestures — which cannot
happen, because there is one pointer.

The alternative, a React context above every list in a group (rbd's
`DragDropContext`), was rejected for the reason the whole API was: a
provider is ceremony every simple list pays for a feature only boards use,
and it would make "two lists in a group" a tree relationship rather than a
prop.

### The drop flight is a box, not the ghost

The obvious implementation keeps the `<popup>` ghost alive and animates its
`x`/`y` home. It is wrong, and the test that found it is worth keeping: a
popup is a real override-redirect **window**, so for the animation's
duration it sits over the list and takes the press that follows the drop —
the second press of a double-click lands on a ghost. The flight is an
absolutely positioned box inside the item with `pointerEvents: 'none'`,
easing an offset to zero, which cannot take an input the list should have
had.

### The ghost, and the drag that could not be seen

The first cut drew the ghost in a `<popup dragPreview>`, which is what
core's reference shows. On the cocoa backend it drew nothing: the gesture
worked, the drop landed, and the user saw only the cursor.

The diagnosis from this side was half right and worth keeping as a method
note. What was visible from here — `dragPreview` is consulted only on the
X11 hit-test path, and cocoa's `dragSpec` builds pasteboard items with no
image — was true, and led to a layer workaround: draw the ghost as a box
inside the window instead, chosen by probing the code path the drag would
take. The reasoning was sound and the conclusion was still wrong, because
the actual cause was one level down: **AppKit's tracking loop owns the
thread from the threshold to the release**. No timer of ours fires, no frame
clock ticks, and not even a microtask drains, so _nothing_ an application
renders during a drag reaches the screen — an in-window box no more than a
popup. The workaround could not have worked, and the only reason to believe
it might was that it had not been run on the backend in question.

The lesson is the one this repository keeps relearning: **a fix for a
platform you cannot run is a hypothesis.** Filing it upstream
([react-x11#482](https://github.com/sidorares/react-x11/issues/482)) with
what was actually observed — rather than only shipping the workaround — is
what got it fixed properly, in core 2.8.0
([#484](https://github.com/sidorares/react-x11/pull/484)): a drag's frames
are painted from the callback that reports them, and its renders are
dispatched at discrete priority and flushed there. The preview follows the
pointer on both backends now, and because a popup on cocoa is a
non-activating panel above other applications' windows, it is also the drag
image the desktop sees.

And then the same lesson arrived a second time, from the other side. With
2.8.0 in and the drag visible again, the popup ghost was made the default on
both backends — and on cocoa the list still would not reorder, the drop
highlight almost never appeared, and the release stalled for about a second.

The cause is one line's worth of asymmetry, and it is the same `dragPreview`
prop as before. Core gives **every top-level window** drop machinery, and a
`<popup>` is one, so the preview registers itself as a dragging destination.
On X11 that is harmless because core picks the drop target itself and skips
preview windows (`topLevelAt`). On cocoa AppKit picks it — and the preview,
following the pointer at the pop-up-menu window level, is the frontmost
registered window under the pointer for the whole gesture. It takes the
hover and the drop that the list was meant to get. Filed as
[react-x11#488](https://github.com/sidorares/react-x11/issues/488).

That was found the way the first one should have been: **headlessly, over the
recording fake bridge core's own `test/cocoa-dnd.test.js` uses**, driving the
real `CocoaApp` through a whole drag against a real `<ReorderList>`. It shows
the second window and the extra registration directly —

```
preview = popup                       preview = inline
windows=2 (list=1)                    windows=1 (list=1)
registerDropTypes: [1, 1, 5]          registerDropTypes: [1, 1]
  window 5 popup=true  <- the ghost
```

— and it is repeatable in a second, where driving a real cocoa session with
synthetic CGEvents took an afternoon and still could not separate the
product's behaviour from the rig's. **The lesson worth keeping: when a
backend cannot be driven by hand, drive its transport.** Core's fake-bridge
tests are the seam for that, and this package can use it without owning it.

For one release `'auto'` was therefore the popup where react-x11 tracks the
drag and the in-window box where the platform does, probed on `typeof
window.beginDrag === 'function'` — the condition `DragSession._start` itself
branches on. **#488 landed in 2.8.1** (`_initDnd` returns early for a window
whose props say `dragPreview`: no session, no registry entry, no property),
so the probe is gone and `'auto'` is a popup on both backends again.
Validated the way the bug was found — over the fake bridge, `registerDropTypes`
is called for the list's window alone where 2.8.0 called it for the ghost's
too, and the drop reorders.

The in-window ghost stays as `preview="inline"`, and it brought its own
lesson while it was the default, reported from a palette dropping into a list
beside it: the ghost drew _under_ the notes it was
being dropped on. `zIndex` here sorts a node among its **siblings** —
`paintOrder()` is per node and there is no stacking context to escape — so
lifting the ghost inside its item cannot raise it above a different list.
The list root is lifted for the length of the gesture too, which is what
covers a palette and its target, a board's columns, any two lists that are
siblings. It genuinely cannot cover two lists in separate wrappers, and
saying so in the reference is better than a deeper trick — it is also the
sharpest argument for why `'auto'` is a window: a popup has no stacking
limit at all.

That one is pinned in **pixels** (`test/reorder.test.ts`, "an inline ghost
paints over the list it is being dragged into"): paint order is the whole
question, so the test samples the pixel under the pointer and fails with the
target's colour rather than the ghost's when the lift is removed. A
structural assertion about `zIndex` would have passed either way.

What survives from the workaround, on merit rather than necessity:

- **`preview: 'auto' | 'popup' | 'inline' | false`.** `'auto'` is the popup
  everywhere; `'inline'` stays as the opt-in for a list that would rather
  not open a window per drag — a remote display — and accepts that the copy
  stops at the window's edge. It costs one branch, and it is the same box
  the drop flight already needed.
- **The popup is `transparent`.** A rounded card in an opaque window shows
  the window's ground in the corners the radius gives up. Core's own example
  was fixed the same way in the same release.

The floor is therefore react-x11 **^2.8.0**, and that is a real floor rather
than tidiness: on 2.7.0 a cocoa drag is invisible whatever this component
does.

## Open questions

- **`items` on the list.** Reading the order from the tree makes the basic
  case shorter. If a caller ever needs the order before layout — a keyboard
  move on the first frame — an optional `items` prop is the rung, and
  nothing else changes.
- **Sliding neighbours.** See above; a `slide` rung if wanted, and every
  rung since has left it buildable in the same place.
- **A reorderable `<Table>` / `<Tree>`.** The model module was written to be
  promoted to `src/internal/` when a second consumer arrives.

## Risks

- **The fresh-instance preview** surprises someone with stateful items.
  Documented; `renderPreview` is the answer.
- **Announcement wording** is English and not localisable yet; every
  string is in one table in `index.ts`.
- **Two handlers per cross-list move.** An app that handles the move in
  `onInsert` and also removes in `onRemove` is right; one that does both in
  one of them double-moves. The docs example shows the split, and
  `ReorderRemove.to` is there for an app that wants the source side alone.
