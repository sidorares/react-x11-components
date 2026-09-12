// Commands for the default document — what the toolbar's buttons run, what
// the keymap binds, and what an app's own toolbar reaches for.
//
// Every one is an ordinary ProseMirror `Command` — `(state, dispatch?, view?)
// => boolean` — so it composes with prosemirror-commands' own, runs from
// `handle.run(cmd)`, and answers "could I?" when called without `dispatch`,
// which is how a toolbar greys a button out. The queries beside them
// (`isMarkActive`, `isBlockActive`) are how it lights one up.
import { lift, setBlockType, wrapIn } from 'prosemirror-commands';
import type {
  Attrs,
  MarkType,
  Node as PMNode,
  NodeType,
  Schema,
} from 'prosemirror-model';
import {
  liftListItem,
  splitListItem,
  wrapInList,
} from 'prosemirror-schema-list';
import { TextSelection } from 'prosemirror-state';
import type { Command, EditorState } from 'prosemirror-state';

// --- queries -------------------------------------------------------------------

/** Whether `type` is on the selection — or, with a bare caret, on what the
 *  next character typed would get. */
export function isMarkActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

/** The attributes of the `type` mark on the selection, if it has one. */
export function markAttrs(state: EditorState, type: MarkType): Attrs | null {
  const { from, to, empty, $from } = state.selection;
  if (empty)
    return type.isInSet(state.storedMarks ?? $from.marks())?.attrs ?? null;
  let found: Attrs | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (found) return false;
    found = type.isInSet(node.marks)?.attrs ?? null;
    return true;
  });
  return found;
}

function attrsMatch(node: PMNode, attrs?: Attrs | null): boolean {
  if (!attrs) return true;
  for (const [k, v] of Object.entries(attrs))
    if (node.attrs[k] !== v) return false;
  return true;
}

/** Whether the selection sits in a `type` node (with `attrs`, when given) —
 *  the textblock it is in, or any block around it. */
export function isBlockActive(
  state: EditorState,
  type: NodeType,
  attrs?: Attrs | null,
): boolean {
  const { $from, to } = state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    const node = $from.node(d);
    if (node.type === type && attrsMatch(node, attrs) && to <= $from.end(d))
      return true;
  }
  return false;
}

/** A list is a node whose content is items: `list_item+`, `listItem+`. */
function isList(type: NodeType): boolean {
  const item = type.contentMatch.defaultType;
  return !!item && /item$/i.test(item.name);
}

/** The innermost list around the selection, if any. */
function listAround(state: EditorState): { node: PMNode; pos: number } | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (isList(node.type)) return { node, pos: $from.before(d) };
  }
  return null;
}

// --- blocks --------------------------------------------------------------------

/** `type` with `attrs` — or back to a paragraph when the selection already
 *  is one: how a "Heading 2" button toggles. */
export function toggleBlockType(
  type: NodeType,
  attrs?: Attrs | null,
  fallback?: NodeType,
): Command {
  return (state, dispatch, view) => {
    const back = fallback ?? state.schema.nodes.paragraph;
    if (isBlockActive(state, type, attrs) && back) {
      return setBlockType(back)(state, dispatch, view);
    }
    return setBlockType(type, attrs)(state, dispatch, view);
  };
}

/** Into a blockquote (or any wrapper), or out of the one the selection is in. */
export function toggleWrap(type: NodeType, attrs?: Attrs | null): Command {
  return (state, dispatch, view) =>
    isBlockActive(state, type)
      ? lift(state, dispatch)
      : wrapIn(type, attrs)(state, dispatch, view);
}

/**
 * A list of `listType`: out of it when the selection is already in one,
 * across to it when it is in a list of another kind (a bullet list becomes
 * numbered and keeps its items), into it otherwise.
 */
export function toggleList(listType: NodeType, itemType: NodeType): Command {
  return (state, dispatch, view) => {
    const around = listAround(state);
    if (around && around.node.type === listType) {
      return liftListItem(itemType)(state, dispatch, view);
    }
    if (around && listType.validContent(around.node.content)) {
      dispatch?.(state.tr.setNodeMarkup(around.pos, listType).scrollIntoView());
      return true;
    }
    return wrapInList(listType)(state, dispatch, view);
  };
}

/** The list items the selection touches. */
function itemsIn(
  state: EditorState,
  item: NodeType,
): { pos: number; node: PMNode }[] {
  const { from, to } = state.selection;
  const out: { pos: number; node: PMNode }[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === item) out.push({ pos, node });
    return true;
  });
  return out;
}

/**
 * Tasks: the selected list items become checkable, or plain again when all of
 * them already are. Outside a list, a new list of unchecked tasks.
 */
export function toggleTaskList(schema: Schema): Command {
  const item = schema.nodes.list_item;
  const list = schema.nodes.bullet_list;
  return (state, dispatch, view) => {
    if (!item || !list || !('checked' in (item.spec.attrs ?? {}))) return false;
    const items = itemsIn(state, item);
    if (items.length === 0) {
      return wrapInList(list)(
        state,
        dispatch &&
          ((tr) => {
            const from = tr.mapping.map(state.selection.from);
            const to = tr.mapping.map(state.selection.to);
            tr.doc.nodesBetween(from, to, (node, pos) => {
              if (node.type === item) {
                tr.setNodeMarkup(pos, undefined, {
                  ...node.attrs,
                  checked: false,
                });
              }
              return true;
            });
            dispatch(tr.scrollIntoView());
          }),
        view,
      );
    }
    if (dispatch) {
      const allTasks = items.every((i) => i.node.attrs.checked != null);
      const tr = state.tr;
      for (const { pos, node } of items) {
        tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          checked: allTasks ? null : (node.attrs.checked ?? false),
        });
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Check or uncheck the task item at `pos` — what clicking its box does. */
export function setTaskChecked(pos: number, checked: boolean): Command {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos);
    if (!node || !('checked' in node.attrs)) return false;
    dispatch?.(
      state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked }),
    );
    return true;
  };
}

/** Enter in a list item: a new item — an unchecked one, if this is a task. */
export function splitItem(itemType: NodeType): Command {
  return (state, dispatch, view) => {
    const { $from } = state.selection;
    let attrs: Attrs | undefined;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (node.type === itemType) {
        if (node.attrs.checked != null)
          attrs = { ...node.attrs, checked: false };
        break;
      }
    }
    return splitListItem(itemType, attrs)(state, dispatch, view);
  };
}

/** A rule where the selection is — and a paragraph after it, when nothing
 *  that takes a caret would follow. */
export function insertHorizontalRule(type: NodeType): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const tr = state.tr.replaceSelectionWith(type.create());
    const $after = tr.selection.$from;
    const para = state.schema.nodes.paragraph;
    if (para && !$after.parent.inlineContent && !$after.nodeAfter) {
      tr.insert($after.pos, para.create());
      tr.setSelection(TextSelection.create(tr.doc, $after.pos + 1));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

// --- code ----------------------------------------------------------------------

const INDENT = '  ';

function inCode(state: EditorState): boolean {
  const { $from, $to } = state.selection;
  return !!$from.parent.type.spec.code && $from.sameParent($to);
}

/** Line starts, as positions, of every line the selection touches in the
 *  code block it is in. */
function codeLines(state: EditorState): number[] {
  const { $from, from, to } = state.selection;
  const start = $from.start();
  const text = $from.parent.textContent;
  const out: number[] = [];
  let line = text.lastIndexOf('\n', from - start - 1) + 1;
  for (;;) {
    out.push(start + line);
    const next = text.indexOf('\n', line);
    if (next === -1 || start + next >= to) break;
    line = next + 1;
  }
  return out;
}

/** Tab inside a code block: two spaces, or every selected line indented. */
export const indentCode: Command = (state, dispatch) => {
  if (!inCode(state)) return false;
  if (!dispatch) return true;
  if (state.selection.empty) {
    dispatch(state.tr.insertText(INDENT).scrollIntoView());
    return true;
  }
  const tr = state.tr;
  const lines = codeLines(state);
  for (let i = lines.length - 1; i >= 0; i--) tr.insertText(INDENT, lines[i]);
  dispatch(tr.scrollIntoView());
  return true;
};

/** Shift+Tab inside a code block: up to two spaces off each selected line.
 *  Consumed even when there is nothing to take off — Shift+Tab in code
 *  should not leave the editor while the user is indenting. */
export const dedentCode: Command = (state, dispatch) => {
  if (!inCode(state)) return false;
  if (!dispatch) return true;
  const { doc } = state;
  const tr = state.tr;
  const lines = codeLines(state);
  for (let i = lines.length - 1; i >= 0; i--) {
    let n = 0;
    while (
      n < INDENT.length &&
      doc.textBetween(lines[i] + n, lines[i] + n + 1) === ' '
    )
      n++;
    if (n) tr.delete(lines[i], lines[i] + n);
  }
  if (tr.docChanged) dispatch(tr.scrollIntoView());
  return true;
};

// --- tables --------------------------------------------------------------------

/** Tab / Shift+Tab in a table: the next or the previous cell, its text
 *  selected. Tab in the last cell adds a row. */
export function goToCell(dir: 1 | -1): Command {
  return (state, dispatch) => {
    const { $head } = state.selection;
    let d = $head.depth;
    const role = (depth: number): unknown =>
      $head.node(depth).type.spec.tableRole;
    while (d > 0 && role(d) !== 'cell' && role(d) !== 'header_cell') d--;
    if (d < 2 || role(d - 2) !== 'table') return false;
    const table = $head.node(d - 2);
    const tableStart = $head.start(d - 2);
    const cells: number[] = [];
    table.forEach((row, rowOffset) => {
      row.forEach((_cell, cellOffset) =>
        cells.push(tableStart + rowOffset + 1 + cellOffset),
      );
    });
    const next = cells.indexOf($head.before(d)) + dir;
    if (next < 0) return true;
    if (!dispatch) return true;
    if (next >= cells.length) {
      const lastRow = table.lastChild!;
      const cellType =
        state.schema.nodes.table_cell ?? lastRow.firstChild!.type;
      const row = lastRow.type.create(
        null,
        Array.from(
          { length: lastRow.childCount },
          (_, i) =>
            cellType.createAndFill({
              align: lastRow.child(i).attrs.align ?? null,
            }) ?? cellType.createAndFill()!,
        ),
      );
      const at = tableStart + table.content.size;
      const tr = state.tr.insert(at, row);
      dispatch(
        tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView(),
      );
      return true;
    }
    const cell = state.doc.nodeAt(cells[next])!;
    const from = cells[next] + 1;
    dispatch(
      state.tr
        .setSelection(
          TextSelection.create(state.doc, from, from + cell.content.size),
        )
        .scrollIntoView(),
    );
    return true;
  };
}

// --- links ---------------------------------------------------------------------

/** The extent, in offsets inside `parent`, of the `type` mark around
 *  `offset` — the whole link a caret is in. */
function markRange(
  parent: PMNode,
  offset: number,
  type: MarkType,
): { from: number; to: number } | null {
  let index = -1;
  let childStart = 0;
  parent.forEach((child, childOffset, i) => {
    if (
      index === -1 &&
      childOffset <= offset &&
      offset <= childOffset + child.nodeSize &&
      type.isInSet(child.marks)
    ) {
      index = i;
      childStart = childOffset;
    }
  });
  if (index === -1) return null;
  const mark = type.isInSet(parent.child(index).marks)!;
  let from = childStart;
  let to = childStart + parent.child(index).nodeSize;
  for (let i = index - 1; i >= 0 && mark.isInSet(parent.child(i).marks); i--) {
    from -= parent.child(i).nodeSize;
  }
  for (
    let i = index + 1;
    i < parent.childCount && mark.isInSet(parent.child(i).marks);
    i++
  ) {
    to += parent.child(i).nodeSize;
  }
  return { from, to };
}

/**
 * A link on the selection. On a bare caret inside a link, that whole link
 * gets the new target; on a bare caret anywhere else, `text` (or the href
 * itself) is inserted as a link. `href: null` takes the link off — off the
 * selection, or off the whole link the caret is in.
 */
export function setLink(
  href: string | null,
  title?: string | null,
  text?: string,
): Command {
  return (state, dispatch) => {
    const type = state.schema.marks.link;
    if (!type) return false;
    if (!dispatch) return true;
    const { from, to, empty, $from } = state.selection;
    const around = empty
      ? markRange($from.parent, $from.parentOffset, type)
      : null;
    const start = $from.start();
    if (href === null) {
      if (!empty)
        dispatch(state.tr.removeMark(from, to, type).scrollIntoView());
      else if (around)
        dispatch(
          state.tr.removeMark(start + around.from, start + around.to, type),
        );
      return true;
    }
    const mark = type.create({ href, title: title ?? null });
    if (!empty) {
      dispatch(state.tr.addMark(from, to, mark).scrollIntoView());
      return true;
    }
    if (around && !text) {
      dispatch(
        state.tr
          .removeMark(start + around.from, start + around.to, type)
          .addMark(start + around.from, start + around.to, mark),
      );
      return true;
    }
    const marks = $from.marks().filter((m) => m.type !== type);
    const tr = state.tr.insert(
      from,
      state.schema.text(text || href, [...marks, mark]),
    );
    dispatch(tr.scrollIntoView());
    return true;
  };
}
