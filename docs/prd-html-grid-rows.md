# Breaking a grid's row an item at a time

Design notes for a change to `<Html>`'s columns that was made, shipped to
master and taken out. It was never in a release. What is here is what the next
attempt needs.

## What a browser does

A grid's items stand side by side, and Blink breaks each on its own account
(CSS Grid 1, 12; CSS Fragmentation 3, 4.1). An item goes on at the head of the
next column from its own break, the row ends where its longest item does, and
what comes after starts under it. `<Html>` breaks a row at one place down the
strip for everything beside it: a line that does not fit in one item takes the
others' content with it to the next column.

## What was tried

#1828 marked the units of a row (`GridRow`), made the row one group
(`groupsOf`), and broke it an item at a time as the columns were filled
(`breakRow`), with column tops of each item's own (`rowTops`, through `holds`).
It brought up five WPT tests of css-break/grid: grid-item-fragmentation-023,
-024, -025 and -036, and monolithic-overflow-006.

It also brought three regressions, each found where its tests had no case:

| what                                                                                                                | why                                                                                                                                                                                                         | how it was missed                                                    |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| a row under cloned edges, in rows of columns or in nested columns hung out of its column                            | `fill` breaks no rows there, and the group stayed one piece nothing could break inside. #1848 dropped the marks there                                                                                       | the fuzz had plain columns alone                                     |
| the document was left blank                                                                                         | an item that goes whole (`contain: size`, a scroll container, a clamp, a multicol container) is one unit and its lines are not gathered. Placed as the row is, `gathered.lines.get(line)!` was undefined    | no such item in the fuzz, and no WPT result in the lists run changed |
| a paragraph was drawn whole in its first column, past its foot, and broken without regard to `orphans` and `widows` | `rowsOf` reads `unit.group.column`, where a unit of a row is in `columnOf(unit)`, so `COLUMN_ROWS` was never set (read in the source, not shown by a fix). `breakRow` asks nothing of `orphans` or `widows` | nothing in any fixture was text                                      |

Stage 2, flex lines broken the same way, was written and not merged. It had the
second fault, and was reported as bringing up a test it left blank: a test and
a reference that both come out blank match.

## What the checks missed

| check                                                                                                                  | what it had none of                        | so it could not see                                                                |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| the 100 cases #1828 came with, `scripts/conformance/grid-rows.ts`                                                      | anything but plain columns, and text       | the first regression and the third, and, as no item in them goes whole, the second |
| the 160 cases #1848 came with, of cloned edges, rows of columns, nested columns and a repeated header                  | an item that goes whole, and text          | the second and the third                                                           |
| the 1,712 of css-break, css-multicol and css-position, and the 582 of css-gaps, css-flexbox and css-grid run with them | a result that changed for any of the three | all three, but for a flex test that stage 2 left blank, which read as a pass       |

## What waits

Flex lines broken so (stage 2, `claude/flex-rows-by-item`, unpushed), a table's
rows, a forced break inside an item (rule 2) and lifting what was gated for it
all wait for a round that takes the causes one at a time. It claims nothing
until it has passed the three parts of one check, in order, over generated
documents and against Chromium:

1. nothing throws, comes out blank or newly takes seconds;
2. no case that matched ceases to, rectangle by rectangle;
3. what is drawn, read from pixels, with text in it.

`scripts/conformance/column-rows.ts` is the first two, over 10,000 cases of
every kind of item, and has no text. The third is to be written.

## What the next attempt has to hold

- **Text.** Its lines' places against Chromium, and what is drawn: ink by column
  and row, read from pixels. A rectangle fixture cannot see either fault.
- **`orphans` and `widows`**, in an item as in any block, and what Blink does
  where they and the row's break disagree (grid-item-fragmentation-036).
- **Every reader of a unit's column goes through `columnOf`.** `rowsOf` is one
  that did not.
- **An item that goes whole** is placed by its own unit's column. That alone was
  tried (an item with an unsliced unit of its own kept out of `rowBoxes`): no
  page threw, and of 160 such cases 14 came to match Chromium and none ceased
  to. It was not merged.
- **Every column a row can be in**: cloned edges, rows of columns, nested columns
  and a repeated header, as well as plain.
- **An item aligned in its row**: 18 of 100 cases differ from Chromium, by rules
  not worked out. So do 41 of 49 with a forced break inside an item.
- **No case that matched before may cease to** (`column-rows.ts`). At 41e331b39
  2,243 of its 10,000 match, and 2,122 with #1828, with or without #1848: 175
  came to match, 296 ceased to, and 27 threw.
- **A test that comes out blank, throws, or newly takes seconds is a failure**,
  whatever its comparison says.

`scripts/conformance/grid-row-contexts.ts` writes the cases kept from this,
which `test/html/multicol.test.ts` holds the columns to as they are now.
