// A document handed in from outside — a controlled `value`, the handle's
// `setValue` — put into the editor.
//
// Replacing the whole document with it made every block a new node: each
// one was keyed again and drawn again, and a plugin that walks what a
// transaction changed (prosemirror-tables' `fixTables`) walked all of it. A
// value that streams in — a model writing into the editor — did that for
// every word it gained: 75 ms a word at 3,200 paragraphs. Pure: no React,
// and `test/rich-text-editor-model.test.ts` asks it the rest.
import type { Node as PMNode } from 'prosemirror-model';
import { Selection } from 'prosemirror-state';
import type { EditorState, Transaction } from 'prosemirror-state';

/**
 * The transaction that makes `state`'s document `doc`: a reset, as it
 * always was. To the history, the selection and every plugin that maps a
 * position through it, the whole document is replaced — so an undo reaches
 * nothing from before, the draft an app just cleared included. What changes
 * is which nodes the new document is made of: where it is the same as the
 * old one, it is the old one's nodes, so the blocks the value left alone
 * keep their keys and their drawn elements.
 */
export function replaceDocumentTr(
  state: EditorState,
  doc: PMNode,
  addToHistory: boolean,
): Transaction {
  // First the document as itself, over the whole of it: the step the
  // history and the mapping see, the one they always saw — every position
  // inside the document replaced. It puts back the node objects that were
  // there, so nothing is drawn again for it.
  const tr = state.tr.replaceWith(0, state.doc.content.size, state.doc.content);
  // Then the change, in steps made against the same document.
  for (const step of changedPart(state, doc)?.steps ?? []) tr.step(step);
  // keep the caret about where it was, inside what is there now
  tr.setSelection(
    Selection.near(
      tr.doc.resolve(Math.min(state.selection.head, tr.doc.content.size)),
    ),
  );
  if (!addToHistory) tr.setMeta('addToHistory', false);
  return tr;
}

/** A transaction replacing only where `doc` differs from `state`'s
 *  document; null when it does not. */
function changedPart(state: EditorState, doc: PMNode): Transaction | null {
  const before = state.doc.content;
  const start = before.findDiffStart(doc.content);
  if (start === null) return null;
  let { a: endA, b: endB } = before.findDiffEnd(doc.content)!;
  // Where the change repeats what is beside it ("aa" to "aaa"), the ends
  // found from the back reach past the start found from the front: move
  // both ends on by the overlap, over content the two documents share.
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  let tr = state.tr.replace(start, endA, doc.slice(start, endB));
  if (tr.doc.eq(doc)) return tr;
  // A slice that opens inside a table can be fitted into another shape than
  // the value's. Whole blocks always fit between the ones the two documents
  // share: the top-level blocks the change reaches, then.
  const from = blockStart(state.doc, start);
  tr = state.tr.replaceWith(
    from,
    blockEnd(state.doc, endA),
    doc.content.cut(from, blockEnd(doc, endB)),
  );
  if (tr.doc.eq(doc)) return tr;
  return state.tr.replaceWith(0, state.doc.content.size, doc.content);
}

/** Where the top-level block `pos` is in starts; `pos` itself between two. */
function blockStart(doc: PMNode, pos: number): number {
  const $pos = doc.resolve(pos);
  return $pos.depth === 0 ? pos : $pos.before(1);
}

/** Where the top-level block `pos` is in ends; `pos` itself between two. */
function blockEnd(doc: PMNode, pos: number): number {
  const $pos = doc.resolve(pos);
  return $pos.depth === 0 ? pos : $pos.after(1);
}
