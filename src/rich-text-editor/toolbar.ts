// The toolbar: a row of formatting buttons over the document — the piece of
// editor chrome most apps want and few want to build.
//
// Three rungs on one prop. `toolbar` gives the default set for whatever the
// schema can do; an array picks and orders — built-in names, `'|'` for a
// separator, and items of the app's own beside them; a function renders
// something else entirely, handed the editor to drive. The buttons run the
// same public commands an app's own toolbar would (`./commands.ts`,
// `./tables.ts`), and ask the state whether they are on and whether they can
// run the same way, so the built-in toolbar is a caller of the API rather
// than a second one.
//
// A press never takes focus: a button is not focusable, and its press is
// consumed before the editor's own press handler sees it — so the caret stays
// where the user left it, and the command runs on the selection they can see.
//
// Some buttons belong to a place in the document: a table's rows and columns
// mean something only with the caret in a table. Those say so with
// `visible`, and the bar leaves them out — and any separator left with
// nothing beside it — everywhere else.
//
// Most buttons are a letter or two in the editor's own face. The rest are
// pictures — undo, redo, a link, a task, a table and its parts — and those
// are drawn rather than typed: core's icon set is affordances (a chevron, a
// check) and these are nouns, and no font a desktop happens to have can be
// counted on for ↶ or ☐ (AGENTS.md, "Affordance glyphs come from core's set;
// nouns do not").
import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { MouseEvent as X11MouseEvent } from 'react-x11';
import { tint } from 'react-x11/style';
import type { Style } from 'react-x11/style';
import { toggleMark } from 'prosemirror-commands';
import { redo, redoDepth, undo, undoDepth } from 'prosemirror-history';
import type { Schema } from 'prosemirror-model';
import type { Command, EditorState } from 'prosemirror-state';

import { hx } from '../internal/hx.js';
import { RICHTEXT_ELEMENT } from '../richtext/index.js';
import type { TextRun } from '../richtext/index.js';
import {
  insertHorizontalRule,
  isBlockActive,
  isMarkActive,
  toggleBlockType,
  toggleList,
  toggleTaskList,
  toggleWrap,
} from './commands.js';
import type { EditorLook } from './look.js';
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  columnAlign,
  deleteColumn,
  deleteRow,
  deleteTable,
  hasTables,
  insertTable,
  isInTable,
  setColumnAlign,
} from './tables.js';

const h = React.createElement;

/** One button. */
export interface ToolbarItem {
  /** Stable, and unique in one toolbar. */
  id: string;
  /** What the button shows when it has no `icon` — a letter or two, set in
   *  `labelStyle`. */
  label: string;
  labelStyle?: Omit<TextRun, 'text'>;
  /** Drawn instead of the label: a node, or a function handed the ink the
   *  button's state picked — muted when it cannot run, the accent when it is
   *  on. An icon library's component goes here. */
  icon?: ReactNode | ((ink: string) => ReactNode);
  /** What a screen reader says it is. */
  title: string;
  run: Command;
  /** Whether it is on here — bold is on inside bold text. */
  active?(state: EditorState): boolean;
  /** Whether it can run here. Default: whether `run` could. */
  enabled?(state: EditorState): boolean;
  /** Whether it is in the bar at all here — a table's rows only in a table.
   *  Default: always. */
  visible?(state: EditorState): boolean;
}

/** The built-in items, by name. */
export type ToolbarItemName =
  | 'undo'
  | 'redo'
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'link'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | 'codeBlock'
  | 'rule'
  | 'table'
  | 'rowBefore'
  | 'rowAfter'
  | 'columnBefore'
  | 'columnAfter'
  | 'deleteRow'
  | 'deleteColumn'
  | 'deleteTable'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight';

/** What a `toolbar` array holds: a built-in by name, `'|'`, or an item. */
export type ToolbarEntry = ToolbarItemName | '|' | ToolbarItem;

/** `toolbar={true}`. Whatever the schema cannot do is left out, and the
 *  table's own group shows only with the caret in a table. The column
 *  alignments are there by name, for a bar of an app's own. */
export const DEFAULT_TOOLBAR: readonly ToolbarEntry[] = [
  'undo',
  'redo',
  '|',
  'heading1',
  'heading2',
  'heading3',
  '|',
  'bold',
  'italic',
  'strike',
  'code',
  'link',
  '|',
  'bulletList',
  'orderedList',
  'taskList',
  '|',
  'blockquote',
  'codeBlock',
  'rule',
  'table',
  '|',
  'rowBefore',
  'rowAfter',
  'columnBefore',
  'columnAfter',
  'deleteRow',
  'deleteColumn',
  'deleteTable',
];

// --- the drawn glyphs -------------------------------------------------------------

const GLYPH: Style = { width: 14, height: 14 };

/** A curved arrow, back (undo) or — mirrored — forward (redo). */
function HistoryGlyph({
  ink,
  forward,
}: {
  ink: string;
  forward?: boolean;
}): ReactElement {
  return hx('canvas', {
    style: GLYPH,
    onDraw: (ctx, { width }) => {
      const x = (v: number): number => (forward ? width - v : v);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x(11.5), 11.5);
      ctx.bezierCurveTo(x(11.5), 7.5, x(9), 5.5, x(3.5), 5.5);
      ctx.moveTo(x(6.5), 2.5);
      ctx.lineTo(x(3.5), 5.5);
      ctx.lineTo(x(6.5), 8.5);
      ctx.stroke();
    },
  });
}

/** Two links of a chain on the diagonal, and the bar that joins them. */
function LinkGlyph({ ink }: { ink: string }): ReactElement {
  return hx('canvas', {
    style: GLYPH,
    onDraw: (ctx) => {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      // a pill from one end's centre to the other's
      const pill = (
        ax: number,
        ay: number,
        bx: number,
        by: number,
        r: number,
      ): void => {
        const len = Math.hypot(bx - ax, by - ay);
        const nx = -(by - ay) / len;
        const ny = (bx - ax) / len;
        const a = Math.atan2(ny, nx);
        ctx.beginPath();
        ctx.moveTo(ax + nx * r, ay + ny * r);
        ctx.lineTo(bx + nx * r, by + ny * r);
        ctx.arc(bx, by, r, a, a - Math.PI, true);
        ctx.lineTo(ax - nx * r, ay - ny * r);
        ctx.arc(ax, ay, r, a - Math.PI, a - 2 * Math.PI, true);
        ctx.closePath();
        ctx.stroke();
      };
      pill(3, 11, 5.5, 8.5, 2.25);
      pill(8.5, 5.5, 11, 3, 2.25);
      ctx.beginPath();
      ctx.moveTo(5.25, 8.75);
      ctx.lineTo(8.75, 5.25);
      ctx.stroke();
    },
  });
}

/** A ticked box. */
function TaskGlyph({ ink }: { ink: string }): ReactElement {
  return hx('canvas', {
    style: GLYPH,
    onDraw: (ctx, { width, height }) => {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeRect(1.75, 1.75, width - 3.5, height - 3.5);
      ctx.beginPath();
      ctx.moveTo(4.5, 7.25);
      ctx.lineTo(6.25, 9);
      ctx.lineTo(9.75, 5);
      ctx.stroke();
    },
  });
}

type TablePart =
  | 'table'
  | 'rowBefore'
  | 'rowAfter'
  | 'columnBefore'
  | 'columnAfter'
  | 'deleteRow'
  | 'deleteColumn'
  | 'deleteTable';

/** A table, or the part of one a button adds or takes away: a grid, and a
 *  plus where a row or column goes, or a cross over what goes. */
function TableGlyph({
  ink,
  part,
}: {
  ink: string;
  part: TablePart;
}): ReactElement {
  return hx('canvas', {
    style: GLYPH,
    onDraw: (ctx) => {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.25;
      ctx.lineCap = 'round';
      const grid = (
        x: number,
        y: number,
        w: number,
        gh: number,
        cols: number,
        rows: number,
      ): void => {
        ctx.strokeRect(x, y, w, gh);
        ctx.beginPath();
        for (let c = 1; c < cols; c++) {
          ctx.moveTo(x + (w * c) / cols, y);
          ctx.lineTo(x + (w * c) / cols, y + gh);
        }
        for (let r = 1; r < rows; r++) {
          ctx.moveTo(x, y + (gh * r) / rows);
          ctx.lineTo(x + w, y + (gh * r) / rows);
        }
        ctx.stroke();
      };
      const mark = (cx: number, cy: number, cross: boolean): void => {
        ctx.beginPath();
        if (cross) {
          ctx.moveTo(cx - 2, cy - 2);
          ctx.lineTo(cx + 2, cy + 2);
          ctx.moveTo(cx + 2, cy - 2);
          ctx.lineTo(cx - 2, cy + 2);
        } else {
          ctx.moveTo(cx - 2.5, cy);
          ctx.lineTo(cx + 2.5, cy);
          ctx.moveTo(cx, cy - 2.5);
          ctx.lineTo(cx, cy + 2.5);
        }
        ctx.stroke();
      };
      switch (part) {
        case 'table':
          grid(1.5, 2.5, 11, 9, 3, 3);
          break;
        case 'rowBefore':
          grid(1.5, 6.5, 11, 6, 3, 2);
          mark(7, 2.5, false);
          break;
        case 'rowAfter':
          grid(1.5, 1.5, 11, 6, 3, 2);
          mark(7, 11.5, false);
          break;
        case 'columnBefore':
          grid(6.5, 1.5, 6, 11, 2, 3);
          mark(2.5, 7, false);
          break;
        case 'columnAfter':
          grid(1.5, 1.5, 6, 11, 2, 3);
          mark(11.5, 7, false);
          break;
        case 'deleteRow':
          ctx.strokeRect(1.5, 4, 11, 6);
          mark(7, 7, true);
          break;
        case 'deleteColumn':
          ctx.strokeRect(4, 1.5, 6, 11);
          mark(7, 7, true);
          break;
        case 'deleteTable':
          grid(1.5, 1.5, 8, 8, 2, 2);
          mark(11, 11, true);
          break;
      }
    },
  });
}

/** Four lines set ragged the way a column's text is. */
function AlignGlyph({
  ink,
  align,
}: {
  ink: string;
  align: 'left' | 'center' | 'right';
}): ReactElement {
  return hx('canvas', {
    style: GLYPH,
    onDraw: (ctx, { width }) => {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      [11, 7, 11, 7].forEach((len, i) => {
        const y = 3 + i * 2.75;
        const x =
          align === 'left'
            ? 1.5
            : align === 'right'
              ? width - 1.5 - len
              : (width - len) / 2;
        ctx.moveTo(x, y);
        ctx.lineTo(x + len, y);
      });
      ctx.stroke();
    },
  });
}

// --- the items ------------------------------------------------------------------

/**
 * The built-in items for `schema`. `link` is the one that needs the
 * component: a link needs a target to be typed, and the component owns the
 * popup that asks for one.
 */
export function toolbarItems(
  schema: Schema,
  options: { link?: Command } = {},
): Partial<Record<ToolbarItemName, ToolbarItem>> {
  const { marks, nodes } = schema;
  const out: Partial<Record<ToolbarItemName, ToolbarItem>> = {
    undo: {
      id: 'undo',
      label: 'Undo',
      icon: (ink) => h(HistoryGlyph, { ink }),
      title: 'Undo',
      run: undo,
      enabled: (state) => undoDepth(state) > 0,
    },
    redo: {
      id: 'redo',
      label: 'Redo',
      icon: (ink) => h(HistoryGlyph, { ink, forward: true }),
      title: 'Redo',
      run: redo,
      enabled: (state) => redoDepth(state) > 0,
    },
  };
  const mark = (
    id: ToolbarItemName,
    type: (typeof marks)[string] | undefined,
    label: string,
    title: string,
    labelStyle: Omit<TextRun, 'text'>,
  ): void => {
    if (!type) return;
    out[id] = {
      id,
      label,
      title,
      labelStyle,
      run: toggleMark(type),
      active: (state) => isMarkActive(state, type),
    };
  };
  mark('bold', marks.strong, 'B', 'Bold', { weight: 700 });
  mark('italic', marks.em, 'I', 'Italic', { style: 'italic' });
  mark('strike', marks.strike, 'S', 'Strikethrough', {});
  mark('code', marks.code, '</>', 'Inline code', { family: 'monospace' });
  if (marks.link && options.link) {
    const link = marks.link;
    out.link = {
      id: 'link',
      label: 'Link',
      icon: (ink) => h(LinkGlyph, { ink }),
      title: 'Link',
      run: options.link,
      active: (state) => isMarkActive(state, link),
      enabled: () => true,
    };
  }
  if (nodes.paragraph) {
    const para = nodes.paragraph;
    out.paragraph = {
      id: 'paragraph',
      label: '¶',
      title: 'Paragraph',
      run: toggleBlockType(para),
      active: (state) =>
        isBlockActive(state, para) &&
        state.selection.$from.parent.type === para,
    };
  }
  if (nodes.heading) {
    const heading = nodes.heading;
    for (const level of [1, 2, 3] as const) {
      out[`heading${level}`] = {
        id: `heading${level}`,
        label: `H${level}`,
        title: `Heading ${level}`,
        labelStyle: { weight: 700 },
        run: toggleBlockType(heading, { level }),
        active: (state) => isBlockActive(state, heading, { level }),
      };
    }
  }
  const item = nodes.list_item;
  if (item && nodes.bullet_list) {
    const list = nodes.bullet_list;
    out.bulletList = {
      id: 'bulletList',
      label: '•',
      title: 'Bulleted list',
      labelStyle: { weight: 700 },
      run: toggleList(list, item),
      active: (state) =>
        isBlockActive(state, list) &&
        state.selection.$from.node(Math.max(0, state.selection.$from.depth - 1))
          .attrs.checked == null,
    };
    if ('checked' in (item.spec.attrs ?? {})) {
      out.taskList = {
        id: 'taskList',
        label: '[x]',
        icon: (ink) => h(TaskGlyph, { ink }),
        title: 'Task list',
        run: toggleTaskList(schema),
        active: (state) => {
          const { $from } = state.selection;
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type === item)
              return $from.node(d).attrs.checked != null;
          }
          return false;
        },
      };
    }
  }
  if (item && nodes.ordered_list) {
    const list = nodes.ordered_list;
    out.orderedList = {
      id: 'orderedList',
      label: '1.',
      title: 'Numbered list',
      run: toggleList(list, item),
      active: (state) => isBlockActive(state, list),
    };
  }
  if (nodes.blockquote) {
    const quote = nodes.blockquote;
    out.blockquote = {
      id: 'blockquote',
      label: '“',
      title: 'Quote',
      labelStyle: { weight: 700 },
      run: toggleWrap(quote),
      active: (state) => isBlockActive(state, quote),
    };
  }
  if (nodes.code_block) {
    const code = nodes.code_block;
    out.codeBlock = {
      id: 'codeBlock',
      label: '{ }',
      title: 'Code block',
      labelStyle: { family: 'monospace' },
      run: toggleBlockType(code),
      active: (state) => isBlockActive(state, code),
    };
  }
  if (nodes.horizontal_rule) {
    out.rule = {
      id: 'rule',
      label: '—',
      title: 'Divider',
      run: insertHorizontalRule(nodes.horizontal_rule),
    };
  }
  if (hasTables(schema)) {
    out.table = {
      id: 'table',
      label: 'Table',
      icon: (ink) => h(TableGlyph, { ink, part: 'table' }),
      title: 'Table',
      run: insertTable(),
      active: isInTable,
    };
    const part = (id: TablePart, title: string, run: Command): ToolbarItem => ({
      id,
      label: title,
      icon: (ink) => h(TableGlyph, { ink, part: id }),
      title,
      run,
      visible: isInTable,
    });
    out.rowBefore = part('rowBefore', 'Row above', addRowBefore);
    out.rowAfter = part('rowAfter', 'Row below', addRowAfter);
    out.columnBefore = part('columnBefore', 'Column before', addColumnBefore);
    out.columnAfter = part('columnAfter', 'Column after', addColumnAfter);
    out.deleteRow = part('deleteRow', 'Delete row', deleteRow);
    out.deleteColumn = part('deleteColumn', 'Delete column', deleteColumn);
    out.deleteTable = part('deleteTable', 'Delete table', deleteTable);
    for (const [id, align] of [
      ['alignLeft', 'left'],
      ['alignCenter', 'center'],
      ['alignRight', 'right'],
    ] as const) {
      out[id] = {
        id,
        label: `Align ${align}`,
        icon: (ink) => h(AlignGlyph, { ink, align }),
        title: `Align column ${align}`,
        // pressed again, it takes the alignment off
        run: (state, dispatch) =>
          setColumnAlign(columnAlign(state) === align ? null : align)(
            state,
            dispatch,
          ),
        active: (state) => columnAlign(state) === align,
        visible: isInTable,
      };
    }
  }
  return out;
}

/** Entries as items: names resolved, the ones the schema cannot do dropped,
 *  and no separator left leading, trailing or doubled. */
export function resolveToolbar(
  entries: readonly ToolbarEntry[],
  items: Partial<Record<ToolbarItemName, ToolbarItem>>,
): (ToolbarItem | '|')[] {
  const out: (ToolbarItem | '|')[] = [];
  for (const entry of entries) {
    const item =
      typeof entry === 'string' && entry !== '|' ? items[entry] : entry;
    if (!item) continue;
    if (item === '|' && (out.length === 0 || out[out.length - 1] === '|'))
      continue;
    out.push(item);
  }
  while (out[out.length - 1] === '|') out.pop();
  return out;
}

/** The entries in the bar for `state`: the invisible ones out, and the
 *  separators that were only between them with them. */
function shownEntries(
  entries: readonly (ToolbarItem | '|')[],
  state: EditorState,
): (ToolbarItem | '|')[] {
  const out: (ToolbarItem | '|')[] = [];
  for (const entry of entries) {
    if (entry !== '|' && entry.visible && !entry.visible(state)) continue;
    if (entry === '|' && (out.length === 0 || out[out.length - 1] === '|'))
      continue;
    out.push(entry);
  }
  while (out[out.length - 1] === '|') out.pop();
  return out;
}

export interface ToolbarProps {
  entries: readonly (ToolbarItem | '|')[];
  state: EditorState;
  run(command: Command): void;
  look: EditorLook;
  disabled?: boolean;
  style?: Style;
}

function button(item: ToolbarItem, props: ToolbarProps): ReactNode {
  const { state, look, run, disabled } = props;
  const active = item.active?.(state) ?? false;
  const enabled =
    !disabled && (item.enabled ? item.enabled(state) : item.run(state));
  // a button that cannot run is drawn in the muted ink — react-x11 styles
  // have no opacity to fade it with
  const ink = !enabled ? look.muted : active ? look.accent : look.text;
  let content: ReactNode;
  if (item.icon != null) {
    content = typeof item.icon === 'function' ? item.icon(ink) : item.icon;
  } else {
    const label: TextRun = {
      text: item.label,
      family: look.family,
      size: look.size,
      color: ink,
      ...item.labelStyle,
      ...(item.id === 'strike' ? { strike: ink } : null),
    };
    if (item.labelStyle?.family === 'monospace') label.family = look.mono;
    content = h(RICHTEXT_ELEMENT, { runs: [label], wrap: false });
  }
  return hx(
    'box',
    {
      key: item.id,
      role: 'button',
      'aria-label': item.title,
      'aria-pressed': active,
      focusable: false,
      style: {
        minWidth: 26,
        height: 26,
        paddingLeft: 6,
        paddingRight: 6,
        borderRadius: 5,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? tint(look.accent, 0.16) : 'transparent',
        ...(enabled
          ? { ':hover': { backgroundColor: tint(look.text, 0.08) } }
          : null),
      },
      onMouseDown: (ev: X11MouseEvent) => {
        // the editor's own press handler is on the root, above: stop here,
        // so the caret stays put, and prevent core's default action too
        ev.preventDefault();
        ev.stopPropagation();
        if (enabled) run(item.run);
      },
    },
    content,
  );
}

export function Toolbar(props: ToolbarProps): ReactElement {
  const { look } = props;
  const entries = shownEntries(props.entries, props.state);
  return hx(
    'box',
    {
      role: 'toolbar',
      style: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 2,
        paddingLeft: 6,
        paddingRight: 6,
        paddingTop: 4,
        paddingBottom: 4,
        borderBottomWidth: 1,
        borderBottomColor: look.border,
        backgroundColor: look.surface,
        ...props.style,
      },
    },
    ...entries.map((entry, i) =>
      entry === '|'
        ? hx('box', {
            key: `sep${i}`,
            style: {
              width: 1,
              height: 16,
              marginLeft: 4,
              marginRight: 4,
              backgroundColor: look.border,
            },
          })
        : button(entry, props),
    ),
  );
}
