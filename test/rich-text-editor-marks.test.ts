// A mark added across a whole document is one step, not one a textblock
// (src/rich-text-editor/marks.ts). What has to hold is everything else:
// the document the command leaves, what an undo gives back, and that a node
// which already had the mark, or cannot take it, is left out of every step.
import { test } from 'node:test';
import assert from 'node:assert';
import { toggleMark as pmToggleMark } from 'prosemirror-commands';
import { history, undo } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import { AllSelection, EditorState } from 'prosemirror-state';
import type { Command, Transaction } from 'prosemirror-state';
import { AddMarkStep } from 'prosemirror-transform';
import { addMarkAcross, toggleMark } from '../src/rich-text-editor/marks.js';
import { schema } from '../src/rich-text-editor/schema.js';

const { strong, em, code } = schema.marks;

/** Paragraphs of plain text, with bold in some, a code block, a rule and an empty paragraph. */
function documentOf(blocks: number, seed = 1): PMNode {
  let s = seed;
  const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const content: PMNode[] = [];
  for (let i = 0; i < blocks; i++) {
    const pick = r();
    if (pick < 0.08) {
      content.push(
        schema.nodes.code_block.create(
          null,
          schema.text(`const x${i} = ${i};`),
        ),
      );
    } else if (pick < 0.12) {
      content.push(schema.nodes.horizontal_rule.create());
    } else if (pick < 0.16) {
      content.push(schema.nodes.paragraph.create());
    } else {
      const parts: PMNode[] = [schema.text(`words ${i} `)];
      if (r() < 0.3) parts.push(schema.text(`bold ${i}`, [strong.create()]));
      if (r() < 0.3) parts.push(schema.text(` leaning ${i}`, [em.create()]));
      if (r() < 0.2) parts.push(schema.text(` code ${i}`, [code.create()]));
      parts.push(schema.text(` end ${i}`));
      content.push(schema.nodes.paragraph.create(null, parts));
    }
  }
  return schema.nodes.doc.create(null, content);
}

function run(command: Command, state: EditorState): Transaction {
  let tr: Transaction | null = null;
  assert.ok(
    command(state, (t) => (tr = t)),
    'the command applies',
  );
  return tr!;
}

test('addMarkAcross leaves the document addMark does, in fewer steps', () => {
  for (const blocks of [1, 2, 7, 60]) {
    for (const mark of [strong.create(), em.create(), code.create()]) {
      const doc = documentOf(blocks, blocks * 7 + 1);
      const state = EditorState.create({ doc });
      const theirs = state.tr.addMark(0, doc.content.size, mark);
      const ours = addMarkAcross(state.tr, 0, doc.content.size, mark);
      assert.ok(
        ours.doc.eq(theirs.doc),
        `${blocks} blocks, ${mark.type.name}: the same document`,
      );
      assert.ok(
        ours.steps.length <= theirs.steps.length,
        `${ours.steps.length} steps against ${theirs.steps.length}`,
      );
      // and undone, the document it started from — every step inverted, last first
      let back = ours.doc;
      for (let i = ours.steps.length - 1; i >= 0; i--) {
        back = ours.steps[i].invert(ours.docs[i]).apply(back).doc!;
      }
      assert.ok(
        back.eq(doc),
        `${blocks} blocks, ${mark.type.name}: undone exactly`,
      );
    }
  }
});

test('bold over paragraphs with nothing bold in them is one step', () => {
  const content: PMNode[] = [];
  for (let i = 0; i < 500; i++)
    content.push(
      schema.nodes.paragraph.create(null, schema.text(`paragraph ${i}`)),
    );
  const doc = schema.nodes.doc.create(null, content);
  const tr = addMarkAcross(
    EditorState.create({ doc }).tr,
    0,
    doc.content.size,
    strong.create(),
  );
  assert.equal(tr.steps.filter((s) => s instanceof AddMarkStep).length, 1);
  assert.equal(
    EditorState.create({ doc }).tr.addMark(0, doc.content.size, strong.create())
      .steps.length,
    500,
  );
});

test('the command toggles as prosemirror-commands does, and undoes to the start', () => {
  const doc = documentOf(40, 3);
  for (const type of [strong, em, code]) {
    const start = EditorState.create({ doc, plugins: [history()] });
    const all = start.apply(start.tr.setSelection(new AllSelection(start.doc)));
    const theirs = all.apply(run(pmToggleMark(type), all));
    const on = all.apply(run(toggleMark(type), all));
    assert.ok(on.doc.eq(theirs.doc), `${type.name} on: the same document`);
    // and off again, all of it
    const off = on.apply(run(toggleMark(type), on));
    const theirsOff = theirs.apply(run(pmToggleMark(type), theirs));
    assert.ok(off.doc.eq(theirsOff.doc), `${type.name} off: the same document`);
    // undo walks back through both toggles to where it began
    let back = off;
    for (let i = 0; i < 2; i++) back = back.apply(run(undo, back));
    assert.ok(back.doc.eq(doc), `${type.name}: undone to the start`);
  }
});

test('added over text some of which has it already, the command undoes exactly', () => {
  // removeWhenPresent: false adds wherever the mark is missing, so the add
  // path runs over mixed text — the runs have to stop at what was bold
  const doc = documentOf(40, 11);
  for (const type of [strong, em, code]) {
    const start = EditorState.create({ doc, plugins: [history()] });
    const all = start.apply(start.tr.setSelection(new AllSelection(start.doc)));
    const options = { removeWhenPresent: false };
    const theirs = all.apply(run(pmToggleMark(type, null, options), all));
    const tr = run(toggleMark(type, null, options), all);
    const on = all.apply(tr);
    assert.ok(on.doc.eq(theirs.doc), `${type.name}: the same document`);
    assert.ok(tr.steps.length > 0, 'something was added');
    const back = on.apply(run(undo, on));
    assert.ok(back.doc.eq(doc), `${type.name}: undone to the start`);
  }
});

test('a cursor toggles the stored mark, as it always did', () => {
  const doc = documentOf(3, 5);
  const state = EditorState.create({ doc });
  const tr = run(toggleMark(strong), state);
  assert.ok(
    tr.storedMarks?.some((m) => m.type === strong),
    'bold is stored for what is typed next',
  );
  assert.equal(tr.steps.length, 0);
});
