# Tree

```jsx
import { Tree } from '@react-x11/components/tree';
```

```jsx
<Tree
  items={[
    {
      id: 'src',
      label: 'src',
      children: [{ id: 'src/index.ts', label: 'index.ts' }],
    },
    { id: 'package.json', label: 'package.json' },
  ]}
  onActivate={(id) => open(id)}
/>
```

A disclosure tree: file browsers, outline panes, property inspectors, anything
with a twisty. It registers no host element — a tree is `<box>`, `<text>` and
core's `<Icon>` — so importing it has **no side effect at import time at all**.

This is a **successor to react-x11's own `<Tree>`, not a wrapper around it**.
Core's is being retired; nothing here imports it and the two share no code.
What is kept is the behaviour a user has already learnt — the keyboard map,
type-ahead, the twisty being its own hit target. The rendering is new, because
that is what needed to change: the tree reads the app's own data, virtualizes,
and exposes every visible part as a seam.

The default look is deliberately plain: a chevron for open and closed, no
branch lines, just indentation.

## Items

An item with a `children` **array** is a branch, even when the array is empty
— that is how a directory shows a twisty before anything has listed it. An
item whose children are not known at all says `branch: true` and fills them in
from `onExpandedChange`.

```ts
interface TreeItem {
  id: string | number;
  label?: ReactNode;
  children?: readonly TreeItem[];
  /** A branch whose children have not been loaded. */
  branch?: boolean;
  disabled?: boolean;
}
```

A disabled row is still shown and still opens; it does not take the selection
and the keyboard steps over it.

## Props

| Prop                                                               | Type                                              | Notes                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `items`                                                            | `readonly T[]`                                    | The roots. Default `[]`.                                                                                  |
| `expanded` / `defaultExpanded`                                     | `readonly TreeItemId[]`                           | Controlled and uncontrolled open sets.                                                                    |
| `onExpandedChange`                                                 | `(expanded, change: TreeExpandChange<T>) => void` | The whole set, plus the one row that changed. The second argument is what lazy loading reads.             |
| `selected` / `defaultSelected`                                     | `TreeItemId \| null`                              | One row — see "Selection is one row" below.                                                               |
| `onSelect`                                                         | `(id, item: T) => void`                           | A click, or the keyboard moving the cursor.                                                               |
| `onActivate`                                                       | `(id, item: T) => void`                           | The _open_ gesture on top of selection: a double click, `Enter`, or `Space`. On a branch it also toggles. |
| `indent`                                                           | `number`                                          | One level of indent. Default 14. `0` puts the whole indent in `renderSubtree`'s hands.                    |
| `rowHeight`                                                        | `number`                                          | Default 22. Virtualization is arithmetic over it.                                                         |
| `virtual`                                                          | `boolean \| 'auto'`                               | Build only the rows on screen. Default `'auto'`: on past 200 visible rows.                                |
| `overscan`                                                         | `number`                                          | Rows built either side of the viewport. Default 6.                                                        |
| `layout`                                                           | `'flat'` (default) \| `'nested'`                  | Whether rows are siblings or grouped into subtree containers. See below.                                  |
| `getId` `getLabel` `getText` `getChildren` `isBranch` `isDisabled` | accessors over `T`                                | How to read the app's own node type. Default to `TreeItem`'s shape. **Memoize them** — see below.         |
| `renderToggle`                                                     | `(state: TreeToggleState<T>) => ReactNode`        | The open/close control, inside its hit box.                                                               |
| `renderGuide`                                                      | `(state: TreeGuideState<T>) => ReactNode`         | One column of the indent — the branch edge. Nothing by default.                                           |
| `renderLabel`                                                      | `(state: TreeRowState<T>) => ReactNode`           | The label cell. An icon in front of the text goes here.                                                   |
| `renderContent`                                                    | `(state, content: ReactNode[]) => ReactNode`      | Everything inside the row box, given what would have been there.                                          |
| `renderSubtree`                                                    | `(state: TreeSubtreeState<T>, rows) => ReactNode` | The subtree container, in `layout="nested"`.                                                              |
| `styles`                                                           | `TreeStyles<T>`                                   | `{ row, toggle, guide, label, subtree }`. `row` and `guide` also take a function of the state.            |
| `style`                                                            | `StyleProp`                                       | The scroll container.                                                                                     |
| `ref`                                                              | `Ref<TreeHandle<T>>`                              | See below.                                                                                                |

Everything `<box>` takes passes through to the container, including
`aria-label` and `onScroll`.

## Reading the app's own data

There is no step where a filesystem listing, an AST or a normalized store is
copied into a shape this component preferred. Hand over the accessors instead:

```jsx
<Tree
  items={entries}
  getId={(e) => e.path}
  getLabel={(e) => e.name}
  getText={(e) => e.name}
  getChildren={(e) => e.entries}
  isBranch={(e) => e.isDirectory}
/>
```

`getText` looks redundant next to `getLabel` and is not. Type-ahead matches on
text, and a label rendered as an icon beside a `<text>` is a React element —
`String()` of it is `[object Object]`. Without `getText` a tree with custom
labels quietly stops answering the keyboard.

`getChildren` returning `undefined` means "not loaded", which is not the same
as `[]`. That is the distinction `isBranch` exists for.

**Define the accessors outside the component, or memoize them.** The
flattening is keyed on their identity — an `isBranch` that reads state has to
be able to change what the tree shows — so a fresh arrow per render
re-flattens the tree per render. On a small tree that costs nothing; on a
large one it is the whole cost, which is exactly backwards from what an app
would guess.

## Lazy loading

A directory nobody has listed is a branch with no children, and the twisty is
clickable the whole time. `onExpandedChange`'s second argument is the row that
changed, which is the fetch:

```jsx
<Tree
  items={tree}
  expanded={expanded}
  onExpandedChange={(ids, change) => {
    setExpanded(ids);
    if (change.open && !change.item.children) load(change.item);
  }}
  isBranch={(e) => e.isDirectory}
  getChildren={(e) => e.children}
/>
```

An expanded branch with nothing under it yet is an ordinary state, not an
error: the twisty is open and the tree has no rows to put there this frame.

## Virtualization

Past `virtual="auto"`'s threshold the tree builds only the rows near the
viewport and stands two spacer boxes in for the rest, so the scrollbar still
measures the whole tree. Ten thousand rows mount about forty.

Two things it costs, and they are why the threshold exists rather than
virtualizing always:

- **Every row must be `rowHeight` tall.** If rows vary — a `renderContent`
  that wraps, a row with a second line — pass `virtual={false}`.
- **Only the built rows are in the accessibility tree**, which is the same set
  a sighted user can see. Each one still carries `aria-level`,
  `aria-posinset` and `aria-setsize` for the whole tree.

`layout="nested"` is never virtualized whatever `virtual` says. A slice of a
list is a list; a slice of a tree is not.

## Laying one out

A `<Tree>` is a scroll container, and a scroll container only scrolls if
something above it bounds its height. **Every flex ancestor between the window
and the tree needs `minHeight: 0`**:

```jsx
<box style={{ flexGrow: 1, flexDirection: 'row', minHeight: 0 }}>
  <box style={{ width: 280, flexShrink: 0, minHeight: 0 }}>
    <text style={{ fontSize: 11 }}>worktrees</text>
    <Tree items={items} />
  </box>
  <box style={{ flexGrow: 1 }}>{/* the detail pane */}</box>
</box>
```

This is CSS's `min-height: auto` and not something this component invents: a
flex item's automatic minimum size is its content, so a sidebar that does not
say `minHeight: 0` refuses to shrink to the window and grows to the height of
the whole expanded tree instead. The tree's own root already says it, which is
why the symptom is not "the tree overflows" but **"expanding a branch stops
the tree scrolling"** — the container inside an ancestor that is already
taller than the window has nothing left to scroll, so opening a folder just
makes the window's content taller.

A row is exactly `rowHeight` tall and its label refuses to wrap, so a name too
long for the panel is clipped rather than wrapped onto a second line the row
has no room for. A tree that should scroll sideways instead, or show an
ellipsis, does it through `renderLabel`.

## Keyboard

The tree is a single tab stop.

| Key                 | What it does                                            |
| ------------------- | ------------------------------------------------------- |
| `Up` / `Down`       | Walk the visible rows, skipping disabled ones.          |
| `Right`             | Expand a branch, then step into it. Mirrored under RTL. |
| `Left`              | Collapse a branch, then step out to the parent.         |
| `PageUp` / `PageDn` | Move by a viewport.                                     |
| `Home` / `End`      | The ends.                                               |
| `Enter` / `Space`   | Activate — and toggle, on a branch.                     |
| letters             | Type-ahead, the same one core's `Select` and menus use. |

**The focus is on the tree, not on the row.** Core's tree focused each row
node; a virtualized row unmounts the moment it scrolls out of view and the
focus would go with it. So the container is the focusable thing and the
selection is the cursor — the model `Table` uses, for the same reason.

## Selection is one row

Multiple selection is not a prop, and that is deliberate: nobody agrees on the
policy. Does `Shift` extend from the anchor or from the cursor? Does
`Ctrl`+click on a branch take its children? Every such policy is expressible
on what is here — hold the set yourself, pass `selected` for the cursor, and
paint the rest from `styles.row`:

```jsx
<Tree
  selected={cursor}
  onSelect={(id) => setCursor(id)}
  styles={{
    row: (state) => picked.has(state.id) && { backgroundColor: '$accentHover' },
  }}
/>
```

## Seams

Each part the tree draws is a render prop with a style override beside it.
The state every one of them is handed carries the row — `id`, `item`, `depth`,
`branch`, `open`, `disabled`, `index`, `parent`, `last`, `posInSet`,
`setSize` — plus `selected`, the `color` the row is painted in, and `toggle()`
and `select()`.

`color` is handed over by name because **colour does not cascade into a
drawing**: an `<Icon>` or a `<canvas mono>` takes its colour from its own
style, so a glyph that has to stay legible on a selected row has to be told.
A `<text>` needs nothing — text does inherit.

A seam's return is **keyed by the component**, so a render prop never has to
remember one.

### `renderGuide` — the branch edge

Called once per level of depth, outermost first. `continues` says whether a
line passes through that column at all, and `own` marks the row's own column —
where a `├─` or `└─` connector goes.

The rule worth stating, because it is the one an implementation gets
backwards: column `k` carries the line joining the **children** of the
ancestor at depth `k`. So a row deep inside the _last_ child of a branch has a
blank column above it, even when that branch's own parent has siblings left.
The line stops at the last child; nothing below it is joined to anything.

```jsx
<Tree
  renderGuide={(g) =>
    g.continues || g.own ? (
      <canvas
        mono
        cacheKey={`edge:${g.own}:${g.continues}:${g.width}x${g.height}`}
        onDraw={edges[g.own ? (g.continues ? 'tee' : 'elbow') : 'through']}
        style={{ flexGrow: 1, alignSelf: 'stretch', color: '$border' }}
      />
    ) : null
  }
/>
```

With no `renderGuide` the indent is one padding value rather than `depth`
empty boxes — a tree ten deep would otherwise build ten nodes per row to draw
nothing.

`branchEdges(row)` is exported for computing the same answer outside a render.

### `renderSubtree` and `layout="nested"`

`layout="flat"` (the default) makes every row a sibling, which is what lets
the tree virtualize. `layout="nested"` puts each expanded branch's rows inside
a container of their own, for a background, a rule down the group, or an
indent of its own.

**Rows carry their own indent in both layouts**, so a subtree container that
also indents should pass `indent={0}`.

The nesting is a regrouping of the flat rows rather than a second traversal,
so the two layouts cannot disagree about depth, order, or which row is last.
A branch that is expanded but still loading gets no container — an empty one
would still paint whatever `renderSubtree` gives it.

## `TreeHandle`

```ts
interface TreeHandle<T = TreeItem> {
  focus: () => void;
  select: (id: TreeItemId | null) => void;
  setExpanded: (id: TreeItemId, open?: boolean) => boolean;
  scrollToItem: (id: TreeItemId) => boolean;
  handleKey: (ev: KeyboardEvent) => boolean;
  rows: () => readonly TreeRow<T>[];
}
```

`handleKey` is the one worth knowing about: a filter box above a tree holds
the keyboard, and forwarding the arrows to this is how the list below it still
walks. It reports whether the tree took the key, so the caller keeps whatever
it did not — the same contract `CalendarHandle.handleKey` has.

`setExpanded` searches the whole loaded tree, not the rows on screen, because
a lazy load finishing under a branch the user collapsed again is a legitimate
thing to expand. An id nothing answers to is a no-op returning `false` rather
than a change event reporting an expansion of `undefined`.

`scrollToItem` returns `false` for a row a collapsed ancestor is hiding: there
is nothing to scroll to.

## The row model

`visibleRows`, `branchEdges` and `findTreeItem` come out through the barrel
(`findItem`, on the subpath). They are pure functions over the same accessors,
and they are what the seams are handed — an app driving a tree from the
outside does the same arithmetic:

```ts
import { visibleRows, resolveAccessors } from '@react-x11/components/tree';
```

The flattening is iterative rather than recursive. A generated tree — a
dependency graph, a filesystem walked to the bottom — is deep enough often
enough that a call per level is a stack overflow waiting for one unlucky user.

## Example

`npm run examples:tree -- <directory>` is a file explorer over the real
filesystem: lazily listed, with lucide-shaped folder glyphs through
`renderLabel` and a dotted branch edge through `renderGuide`. Its glyphs are
drawn in the example, which is the line core's icon set draws — affordances
are core's (the twisty's chevron is `<Icon>`), nouns are the app's.
