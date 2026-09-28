// `toggleMark` from prosemirror-commands, with one difference: a mark is
// added the way prosemirror-transform already removes one.
//
// Its `addMark` makes a step for each run of text that lacks the mark, and a
// run ends where its textblock does. Bold over a document of 1,700 paragraphs
// is 1,700 steps, and each step copies the document's top-level children:
// quadratic in blocks, 425 ms a toggle over the sweep's 600 KB report.
// `removeMark` joins its runs across blocks already.
//
// `addMarkAcross` joins consecutive inline nodes that lack the mark whatever
// lies between them, which can only be block structure. An `AddMarkStep`
// marks the inline nodes of its range whose parent allows the mark and leaves
// everything else alone, and its inverse removes the mark from those same
// nodes, every one of which lacked it. So the document, the undo, and a
// position mapped through the transaction (a mark step maps nothing) are
// what they were. A node that already has the mark, or cannot take it, ends
// the run, as it did.

import { toggleMark as pmToggleMark } from 'prosemirror-commands';
import type { Attrs, Mark, MarkType } from 'prosemirror-model';
import type { Command, EditorState } from 'prosemirror-state';
import {
  AddMarkStep,
  RemoveMarkStep,
  type Transform,
} from 'prosemirror-transform';

interface Run {
  from: number;
  to: number;
}

/** `tr.addMark(from, to, mark)`, one step for a run however many blocks it crosses. */
export function addMarkAcross(
  tr: Transform,
  from: number,
  to: number,
  mark: Mark,
): Transform {
  const removed: Array<Run & { mark: Mark }> = [];
  const added: Run[] = [];
  let removing: (Run & { mark: Mark }) | null = null;
  let adding: Run | null = null;
  tr.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isInline) return;
    const marks = node.marks;
    if (
      mark.isInSet(marks) ||
      !parent ||
      !parent.type.allowsMarkType(mark.type)
    ) {
      adding = null;
      return;
    }
    const start = Math.max(pos, from);
    const end = Math.min(pos + node.nodeSize, to);
    // the marks this one excludes come off first, run for run as addMark does
    const newSet = mark.addToSet(marks);
    for (const other of marks) {
      if (other.isInSet(newSet)) continue;
      if (removing && removing.to === start && removing.mark.eq(other))
        removing.to = end;
      else removed.push((removing = { from: start, to: end, mark: other }));
    }
    if (adding) adding.to = end;
    else added.push((adding = { from: start, to: end }));
  });
  for (const r of removed) tr.step(new RemoveMarkStep(r.from, r.to, r.mark));
  for (const a of added) tr.step(new AddMarkStep(a.from, a.to, mark));
  return tr;
}

/** prosemirror-commands' `toggleMark`, adding through `addMarkAcross`. */
export function toggleMark(
  markType: MarkType,
  attrs: Attrs | null = null,
  options?: Parameters<typeof pmToggleMark>[2],
): Command {
  const command = pmToggleMark(markType, attrs, options);
  return (state, dispatch, view) =>
    command(dispatch ? addingAcross(state) : state, dispatch, view);
}

/**
 * The state as the command sees it: every transaction it starts adds marks
 * through `addMarkAcross`. Only that transaction's own `addMark` is replaced,
 * so nothing else in the process changes.
 */
function addingAcross(state: EditorState): EditorState {
  return new Proxy(state, {
    get(target, prop) {
      if (prop !== 'tr') return Reflect.get(target, prop, target);
      const tr = target.tr;
      tr.addMark = (from: number, to: number, mark: Mark) => {
        addMarkAcross(tr, from, to, mark);
        return tr;
      };
      return tr;
    },
  });
}
