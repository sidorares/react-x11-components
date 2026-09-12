// Table editing: rows and columns in and out, a table where the caret is,
// and a column's alignment — prosemirror-tables' commands, kept to the shape
// a table in markdown has.
//
// prosemirror-tables is the ecosystem's table model. Its `TableMap` answers
// "which cell is at row r, column c" through spans, and its commands are the
// argued-over answers for adding and removing rows and columns; the default
// schema's table nodes carry its `tableRole`s and cell attributes so they
// can be pointed at it (./schema.ts). What it does not know is the rule of
// the editor's value: **a markdown table has one header row, it is the first
// row, and alignment belongs to a column.** prosemirror-tables inserts a row
// above the header as plain cells, leaves a first row that is not a header
// when the header is deleted, and gives a new cell no alignment — each of
// which markdown would read back as something other than what the editor
// showed. So a command here that starts in a table shaped like markdown's
// finishes by putting that shape back (`keepMarkdownShape`); a table shaped
// otherwise — a header column, an HTML table with no header — is left as
// prosemirror-tables leaves it.
//
// Its `tableEditing()` plugin is not used: the cell selection it adds runs
// on DOM mouse events this view does not have. `fixTables` is, through
// `tableRepair` — the repair a pasted ragged table needs before `TableMap`
// can reason about it.
import type { Node as PMNode, NodeType, Schema } from 'prosemirror-model';
import { Plugin, TextSelection } from 'prosemirror-state';
import type { Command, EditorState, Transaction } from 'prosemirror-state';
import {
  addColumnAfter as addColumnAfterPM,
  addColumnBefore as addColumnBeforePM,
  addRowAfter as addRowAfterPM,
  addRowBefore as addRowBeforePM,
  deleteColumn as deleteColumnPM,
  deleteRow as deleteRowPM,
  deleteTable as deleteTablePM,
  findTable,
  fixTables,
  isInTable,
  selectedRect,
  tableNodeTypes,
} from 'prosemirror-tables';

/** A column's alignment, as GFM writes it — `:--`, `:-:`, `--:` — or none. */
export type ColumnAlign = 'left' | 'center' | 'right' | null;

interface TableTypes {
  table: NodeType;
  row: NodeType;
  cell: NodeType;
  /** Null when the schema has no header cell of its own. */
  header: NodeType | null;
}

/** The schema's table node types by prosemirror-tables' roles, or null for
 *  a schema without tables. */
function tableTypes(schema: Schema): TableTypes | null {
  const roles = tableNodeTypes(schema) as Partial<Record<string, NodeType>>;
  const { table, row, cell } = roles;
  if (!table || !row || !cell) return null;
  const header = roles.header_cell;
  return {
    table,
    row,
    cell,
    header: header && header !== cell ? header : null,
  };
}

function alignOf(cell: PMNode): ColumnAlign {
  const a = cell.attrs.align;
  return a === 'left' || a === 'center' || a === 'right' ? a : null;
}

/** Header cells in the first row and nowhere else, and no spans: the only
 *  table markdown can write. */
function markdownShaped(table: PMNode, types: TableTypes): boolean {
  if (!types.header || table.childCount === 0) return false;
  let shaped = true;
  table.forEach((row, _offset, index) => {
    row.forEach((cell) => {
      if ((cell.type === types.header) !== (index === 0)) shaped = false;
      if ((cell.attrs.colspan ?? 1) !== 1 || (cell.attrs.rowspan ?? 1) !== 1)
        shaped = false;
    });
  });
  return shaped;
}

/**
 * Put markdown's shape back on the table at `tablePos`: header cells in the
 * first row and plain ones below, and each column aligned the way the first
 * of its cells that says so is. Cells change type and attributes in place,
 * so no position moves.
 */
function keepMarkdownShape(
  tr: Transaction,
  tablePos: number,
  types: TableTypes,
): void {
  const table = tr.doc.nodeAt(tablePos);
  if (!table || table.type !== types.table || !types.header) return;
  const header = types.header;
  // `??=` fills a column still at null too, so the first cell that says
  // how its column is aligned wins
  const aligns: ColumnAlign[] = [];
  table.forEach((row) => {
    row.forEach((cell, _offset, col) => {
      aligns[col] ??= alignOf(cell);
    });
  });
  table.forEach((row, rowOffset, index) => {
    row.forEach((cell, cellOffset, col) => {
      const type = index === 0 ? header : types.cell;
      const align = aligns[col] ?? null;
      const alignable = 'align' in cell.attrs;
      if (cell.type === type && (!alignable || alignOf(cell) === align)) return;
      tr.setNodeMarkup(
        tablePos + 1 + rowOffset + 1 + cellOffset,
        type,
        alignable ? { ...cell.attrs, align } : cell.attrs,
        cell.marks,
      );
    });
  });
}

type TablesCommand = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
) => boolean;

/** A prosemirror-tables command that leaves a markdown-shaped table
 *  markdown-shaped. */
function keepingShape(command: TablesCommand): Command {
  return (state, dispatch) => {
    const types = tableTypes(state.schema);
    const found = isInTable(state) ? findTable(state.selection.$from) : null;
    if (!dispatch || !types || !found || !markdownShaped(found.node, types))
      return command(state, dispatch);
    return command(state, (tr) => {
      keepMarkdownShape(tr, tr.mapping.map(found.pos), types);
      dispatch(tr.scrollIntoView());
    });
  };
}

/** A row above the one the selection is in. Above a markdown table's
 *  header, the new row becomes the header. */
export const addRowBefore: Command = keepingShape(addRowBeforePM);
/** A row below the one the selection is in. */
export const addRowAfter: Command = keepingShape(addRowAfterPM);
/** The selected rows out. The last row cannot go — delete the table. When a
 *  markdown table loses its header, the row below becomes it. */
export const deleteRow: Command = keepingShape(deleteRowPM);
/** A column before the one the selection is in. */
export const addColumnBefore: Command = keepingShape(addColumnBeforePM);
/** A column after the one the selection is in. */
export const addColumnAfter: Command = keepingShape(addColumnAfterPM);
/** The selected columns out. The last column cannot go. */
export const deleteColumn: Command = keepingShape(deleteColumnPM);
/** The table the selection is in, whole. */
export const deleteTable: Command = deleteTablePM;

/**
 * A table where the selection is: `rows` rows of `cols` columns, the first
 * row a header, and the caret in its first cell — with a paragraph after it
 * when nothing that takes a caret would follow. Not inside another table.
 */
export function insertTable(rows = 3, cols = 3): Command {
  return (state, dispatch) => {
    const types = tableTypes(state.schema);
    if (!types || isInTable(state) || rows < 1 || cols < 1) return false;
    const make = (type: NodeType): PMNode =>
      types.row.create(
        null,
        Array.from({ length: cols }, () => type.createAndFill()!),
      );
    const table = types.table.create(null, [
      make(types.header ?? types.cell),
      ...Array.from({ length: rows - 1 }, () => make(types.cell)),
    ]);
    if (!dispatch) return true;
    const from = state.selection.from;
    const tr = state.tr.replaceSelectionWith(table);
    // the node itself, where the replace put it — or, had fitting copied it,
    // the first table from where the selection was
    let at = -1;
    tr.doc.descendants((node, pos) => {
      if (at >= 0) return false;
      if (node === table) at = pos;
      return true;
    });
    if (at < 0) {
      tr.doc.nodesBetween(
        tr.mapping.map(from, -1),
        tr.doc.content.size,
        (n, pos) => {
          if (at < 0 && n.type === types.table) at = pos;
          return at < 0;
        },
      );
    }
    if (at < 0) return false;
    const end = at + tr.doc.nodeAt(at)!.nodeSize;
    const $end = tr.doc.resolve(end);
    const para = state.schema.nodes.paragraph;
    if (
      para &&
      !$end.nodeAfter &&
      $end.parent.canReplaceWith($end.index(), $end.index(), para)
    ) {
      tr.insert(end, para.create());
    }
    // table, row, cell: three steps in to the first cell's text
    tr.setSelection(TextSelection.create(tr.doc, at + 3));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Every cell of the selected columns aligned: GFM's alignment is a
 *  column's, not a cell's. `null` takes it off. */
export function setColumnAlign(align: ColumnAlign): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    const { map, table, tableStart } = rect;
    const first = table.firstChild?.firstChild;
    if (!first || !('align' in first.attrs)) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    const done = new Set<number>();
    for (let row = 0; row < map.height; row++) {
      for (let col = rect.left; col < rect.right; col++) {
        const at = map.map[row * map.width + col];
        if (done.has(at)) continue;
        done.add(at);
        const cell = table.nodeAt(at);
        if (cell && alignOf(cell) !== align)
          tr.setNodeMarkup(tableStart + at, undefined, {
            ...cell.attrs,
            align,
          });
      }
    }
    dispatch(tr);
    return true;
  };
}

/** The alignment of the column the selection is in, or undefined outside a
 *  table — what lights an alignment button. */
export function columnAlign(state: EditorState): ColumnAlign | undefined {
  if (!isInTable(state)) return undefined;
  const rect = selectedRect(state);
  const cell = rect.table.nodeAt(rect.map.map[rect.left]);
  return cell ? alignOf(cell) : null;
}

export { isInTable };

/** Every table kept rectangular: prosemirror-tables' `fixTables` after each
 *  change, for a table that a paste or an HTML document left ragged. */
export function tableRepair(): Plugin {
  return new Plugin({
    appendTransaction: (_trs, oldState, state) => fixTables(state, oldState),
  });
}

/** Whether the schema has tables prosemirror-tables can edit. */
export function hasTables(schema: Schema): boolean {
  return tableTypes(schema) !== null;
}
