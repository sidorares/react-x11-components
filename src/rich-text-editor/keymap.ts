// Keys, across the one seam ProseMirror's ecosystem is written against: a
// DOM `KeyboardEvent`.
//
// A keymap plugin — prosemirror-keymap's, TipTap's, anyone's — reads
// `event.key`, `event.keyCode` and four modifier flags and nothing else, so a
// react-x11 key event is translated into exactly that and handed to
// `handleKeyDown` as if a browser had sent it. Two details decide whether a
// binding like `Mod-b` fires:
//
// - **The Latin key, under any layout.** With a modifier held, `key` is the
//   character of `ev.keysym` — which react-x11 already resolves to the Latin
//   key of the physical key — and `keyCode` is that key's DOM code, which is
//   also what prosemirror-keymap falls back to. So Ctrl+B bolds while the
//   user is typing Russian, as it does in every toolkit.
// - **Which modifier is Mod.** prosemirror-keymap decides at load time, from
//   `navigator.platform`, that Mod is Cmd on a Mac and Ctrl anywhere else —
//   a fact about the *host*. The answer here is the *backend's*: an X11
//   application uses Ctrl even under XQuartz on a Mac (and the suite's
//   in-process server is X11 on every host), while react-x11's native macOS
//   backend uses Cmd, even on a Node old enough to have no `navigator`, where
//   prosemirror-keymap guesses Ctrl. When the two disagree, Ctrl and Meta
//   trade places in the event a plugin is shown, so the backend's primary
//   modifier always arrives as prosemirror-keymap's Mod.
//
// Below that: the editing behaviour the default schema ships with — the
// plugins `defaultPlugins` assembles, in the order they have to be in.
import {
  baseKeymap,
  chainCommands,
  exitCode,
  setBlockType,
  toggleMark,
  wrapIn,
} from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import {
  InputRule,
  ellipsis,
  emDash,
  inputRules,
  smartQuotes,
  textblockTypeInputRule,
  undoInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { Fragment } from 'prosemirror-model';
import type { MarkType, NodeType, Schema } from 'prosemirror-model';
import {
  liftListItem,
  sinkListItem,
  wrapInList,
} from 'prosemirror-schema-list';
import { TextSelection } from 'prosemirror-state';
import type { Command, Plugin } from 'prosemirror-state';
import { findWrapping } from 'prosemirror-transform';

import {
  dedentCode,
  goToCell,
  indentCode,
  insertHorizontalRule,
  splitItem,
  toggleTaskList,
} from './commands.js';

// --- the event ---------------------------------------------------------------

/** The backend's primary shortcut modifier: Ctrl on X11, Cmd on macOS. */
export type PrimaryModifier = 'ctrl' | 'meta';

/**
 * Which modifier this app's backend uses for shortcuts. react-x11's native
 * macOS application is the one carrying a bezel store (`nativeBezels`, its
 * Cocoa-only view of the window chrome); nothing on the X11 backend or the
 * headless mock has one.
 */
export function primaryModifierOf(app: unknown): PrimaryModifier {
  return app !== null && typeof app === 'object' && 'nativeBezels' in app
    ? 'meta'
    : 'ctrl';
}

const nav = (globalThis as { navigator?: { platform?: string } }).navigator;
/** prosemirror-keymap's own answer, reproduced: is its Mod the Meta key? */
const MOD_IS_META = !!nav && /Mac|iP(hone|[oa]d)/.test(nav.platform ?? '');

/** The slice of a react-x11 key event read here. */
export interface KeyLike {
  keysym?: number;
  key?: string;
  codepoint?: number;
  composing?: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** A DOM `KeyboardEvent`, as far as ProseMirror and w3c-keyname read one. */
export interface DomKeyEvent {
  readonly type: 'keydown';
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly which: number;
  readonly charCode: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  getModifierState(name: string): boolean;
}

/** X keysym → DOM key name and legacy key code, for the keys with names. */
const NAMED = new Map<number, [string, number]>([
  [0xff0d, ['Enter', 13]],
  [0xff8d, ['Enter', 13]], // KP_Enter
  [0xff08, ['Backspace', 8]],
  [0xffff, ['Delete', 46]],
  [0xff9f, ['Delete', 46]], // KP_Delete
  [0xff09, ['Tab', 9]],
  [0xfe20, ['Tab', 9]], // ISO_Left_Tab — what Shift+Tab sends
  [0xff1b, ['Escape', 27]],
  [0xff51, ['ArrowLeft', 37]],
  [0xff52, ['ArrowUp', 38]],
  [0xff53, ['ArrowRight', 39]],
  [0xff54, ['ArrowDown', 40]],
  [0xff96, ['ArrowLeft', 37]],
  [0xff97, ['ArrowUp', 38]],
  [0xff98, ['ArrowRight', 39]],
  [0xff99, ['ArrowDown', 40]],
  [0xff50, ['Home', 36]],
  [0xff95, ['Home', 36]],
  [0xff57, ['End', 35]],
  [0xff9c, ['End', 35]],
  [0xff55, ['PageUp', 33]],
  [0xff9a, ['PageUp', 33]],
  [0xff56, ['PageDown', 34]],
  [0xff9b, ['PageDown', 34]],
  [0xff63, ['Insert', 45]],
  [0xff9e, ['Insert', 45]],
  [0x20, [' ', 32]],
]);
for (let i = 0; i < 12; i++) NAMED.set(0xffbe + i, [`F${i + 1}`, 112 + i]);

/** The US-layout key a character is on, as a DOM key code. */
const PUNCT_CODES: Record<string, number> = {
  ';': 186,
  ':': 186,
  '=': 187,
  '+': 187,
  ',': 188,
  '<': 188,
  '-': 189,
  _: 189,
  '.': 190,
  '>': 190,
  '/': 191,
  '?': 191,
  '`': 192,
  '~': 192,
  '[': 219,
  '{': 219,
  '\\': 220,
  '|': 220,
  ']': 221,
  '}': 221,
  "'": 222,
  '"': 222,
  ')': 48,
  '!': 49,
  '@': 50,
  '#': 51,
  $: 52,
  '%': 53,
  '^': 54,
  '&': 55,
  '*': 56,
  '(': 57,
};

function codeOf(ch: string): number {
  if (/^[a-z]$/i.test(ch)) return ch.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(ch)) return ch.charCodeAt(0);
  return PUNCT_CODES[ch] ?? 0;
}

/** A react-x11 key event as the DOM keydown a keymap expects. */
export function toDomKeyEvent(
  ev: KeyLike,
  primary: PrimaryModifier,
): DomKeyEvent {
  let ctrlKey = !!ev.ctrlKey;
  let metaKey = !!ev.metaKey;
  if ((primary === 'meta') !== MOD_IS_META)
    [ctrlKey, metaKey] = [metaKey, ctrlKey];
  const named = ev.keysym !== undefined ? NAMED.get(ev.keysym) : undefined;
  let key: string;
  let keyCode: number;
  if (named) {
    [key, keyCode] = named;
  } else {
    const latin =
      ev.keysym !== undefined && ev.keysym > 0x20 && ev.keysym < 0x7f
        ? String.fromCharCode(ev.keysym)
        : '';
    const chord = ctrlKey || metaKey || !!ev.altKey;
    key = (chord && latin) || ev.key || latin || 'Unidentified';
    keyCode = codeOf(latin || key);
  }
  let prevented = false;
  const shiftKey = !!ev.shiftKey;
  const altKey = !!ev.altKey;
  return {
    type: 'keydown',
    key,
    code: '',
    keyCode,
    which: keyCode,
    charCode: 0,
    shiftKey,
    ctrlKey,
    altKey,
    metaKey,
    repeat: false,
    isComposing: !!ev.composing,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
    getModifierState(name: string) {
      switch (name) {
        case 'Shift':
          return shiftKey;
        case 'Control':
          return ctrlKey;
        case 'Alt':
          return altKey;
        case 'Meta':
          return metaKey;
        default:
          return false;
      }
    },
  };
}

// --- the default document's behaviour ---------------------------------------

export interface DefaultPluginOptions {
  /** Undo and redo (prosemirror-history), with Mod-z / Mod-y. Default on. */
  history?: boolean;
  /** Markdown as you type: `# `, `> `, `- `, `1. `, `[ ] `, ``` ``` ```,
   *  `---`, and `**bold**`-style marks. Default on. */
  inputRules?: boolean;
  /** Formatting shortcuts — Mod-b, Mod-i, Mod-Alt-1…6, lists, quotes. Default on. */
  keymap?: boolean;
  /** Smart quotes, `...` → `…` and `--` → `—`. Default off: in a markdown
   *  document a straight quote is usually meant. */
  typography?: boolean;
}

/**
 * The plugins the default editor runs, in the order they have to be in:
 * input rules, the formatting keymap (its Enter splits list items before the
 * base keymap's Enter splits blocks), history, and prosemirror-commands'
 * base keymap last. `<RichTextEditor>` puts these in its state; an app that
 * owns the state (`state` + `dispatchTransaction`) builds them in itself.
 */
export function defaultPlugins(
  schema: Schema,
  options: DefaultPluginOptions = {},
): Plugin[] {
  const out: Plugin[] = [];
  const markdown = options.inputRules !== false;
  if (markdown || options.typography) {
    out.push(
      markdownInputRules(schema, {
        markdown,
        typography: !!options.typography,
      }),
    );
  }
  if (options.keymap !== false) out.push(keymap(editingKeymap(schema)));
  if (options.history !== false) {
    out.push(
      history(),
      keymap({ 'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo }),
    );
  }
  out.push(keymap(baseKeymap));
  return out;
}

/** The formatting shortcuts, for whatever of them the schema can do. */
export function editingKeymap(schema: Schema): Record<string, Command> {
  const keys: Record<string, Command> = {};
  const bind = (key: string, cmd: Command): void => {
    keys[key] = keys[key] ? chainCommands(keys[key], cmd) : cmd;
  };
  const { marks, nodes } = schema;

  bind('Backspace', undoInputRule);
  if (marks.strong) bind('Mod-b', toggleMark(marks.strong));
  if (marks.em) bind('Mod-i', toggleMark(marks.em));
  if (marks.code) bind('Mod-`', toggleMark(marks.code));
  if (marks.strike) bind('Shift-Mod-x', toggleMark(marks.strike));

  if (nodes.code_block) {
    // inside a fence, Tab is indentation — and Escape-then-Tab still leaves
    bind('Tab', indentCode);
    bind('Shift-Tab', dedentCode);
  }
  if (nodes.table) {
    bind('Tab', goToCell(1));
    bind('Shift-Tab', goToCell(-1));
  }
  const item = nodes.list_item;
  if (item) {
    bind('Enter', splitItem(item));
    bind('Mod-[', liftListItem(item));
    bind('Mod-]', sinkListItem(item));
    bind('Tab', sinkListItem(item));
    bind('Shift-Tab', liftListItem(item));
  }
  if (nodes.bullet_list) bind('Shift-Mod-8', wrapInList(nodes.bullet_list));
  if (nodes.ordered_list) bind('Shift-Mod-7', wrapInList(nodes.ordered_list));
  if (item && nodes.bullet_list && 'checked' in (item.spec.attrs ?? {})) {
    bind('Shift-Mod-9', toggleTaskList(schema));
  }
  if (nodes.blockquote) bind('Ctrl->', wrapIn(nodes.blockquote));

  const br = nodes.hard_break;
  if (br) {
    const hardBreak = chainCommands(exitCode, (state, dispatch) => {
      dispatch?.(state.tr.replaceSelectionWith(br.create()).scrollIntoView());
      return true;
    });
    bind('Mod-Enter', hardBreak);
    bind('Shift-Enter', hardBreak);
  }
  if (nodes.paragraph) bind('Mod-Alt-0', setBlockType(nodes.paragraph));
  if (nodes.code_block) bind('Mod-Alt-c', setBlockType(nodes.code_block));
  if (nodes.heading) {
    for (let level = 1; level <= 6; level++) {
      bind(`Mod-Alt-${level}`, setBlockType(nodes.heading, { level }));
    }
  }
  if (nodes.horizontal_rule)
    bind('Mod-_', insertHorizontalRule(nodes.horizontal_rule));
  return keys;
}

/**
 * An input rule for a delimited mark: when the closing delimiter is typed,
 * the delimiters go and what they held takes the mark. `match[1]` is the
 * delimited run, `match[2]` what is inside it. The typed character is the
 * last of the closing delimiter and is simply never inserted; the rest of
 * that delimiter is in the document and is deleted. Undoable, like every
 * input rule: Backspace straight after gives the characters back.
 */
function markRule(pattern: RegExp, type: MarkType): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const whole = match[1];
    const inner = match[2];
    const from = start + match[0].length - whole.length;
    const textStart = from + whole.indexOf(inner);
    const textEnd = textStart + inner.length;
    const tr = state.tr;
    if (end > textEnd) tr.delete(textEnd, end);
    tr.delete(from, textStart);
    tr.addMark(from, from + inner.length, type.create());
    tr.removeStoredMark(type);
    return tr;
  });
}

/** `---` (or `***`/`___` and a space) alone in a paragraph: a rule, and a
 *  fresh paragraph after it to go on typing in. */
function ruleRule(rule: NodeType): InputRule {
  return new InputRule(/^(?:---|___\s|\*\*\*\s)$/, (state, _match, start) => {
    const $start = state.doc.resolve(start);
    const para = $start.parent;
    if (!para.isTextblock || $start.parentOffset !== 0 || $start.depth < 1)
      return null;
    const parent = $start.node(-1);
    const index = $start.index(-1);
    const content = Fragment.from([rule.create(), para.type.create()]);
    if (!parent.canReplace(index, index + 1, content)) return null;
    const pos = $start.before();
    const tr = state.tr.replaceWith(pos, pos + para.nodeSize, content);
    return tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 2)));
  });
}

/** `[ ] ` or `[x] ` at the start of a paragraph — or of a list item's first
 *  paragraph — makes it a task. */
function taskRule(schema: Schema): InputRule | null {
  const { list_item: item, bullet_list: list, paragraph } = schema.nodes;
  if (!item || !list || !paragraph || !('checked' in (item.spec.attrs ?? {})))
    return null;
  return new InputRule(/^\[( |x|X)?\]\s$/, (state, match, start, end) => {
    const checked = (match[1] ?? ' ').toLowerCase() === 'x';
    const $start = state.doc.resolve(start);
    if ($start.parentOffset !== 0 || $start.parent.type !== paragraph)
      return null;
    const tr = state.tr.delete(start, end);
    const d = $start.depth - 1;
    if (d > 0 && $start.node(d).type === item && $start.index(d) === 0) {
      return tr.setNodeMarkup($start.before(d), undefined, {
        ...$start.node(d).attrs,
        checked,
      });
    }
    const range = tr.doc.resolve(start).blockRange();
    const wrapping = range && findWrapping(range, list);
    if (!range || !wrapping) return null;
    tr.wrap(range, wrapping);
    // the item the wrap just made sits two positions before the paragraph
    const itemPos = range.start + 1;
    const made = tr.doc.nodeAt(itemPos);
    if (made?.type === item)
      tr.setNodeMarkup(itemPos, undefined, { ...made.attrs, checked });
    return tr;
  });
}

/** Markdown shortcuts, for whatever of them the schema can hold. */
export function markdownInputRules(
  schema: Schema,
  options: { markdown?: boolean; typography?: boolean } = {},
): Plugin {
  const rules: InputRule[] = [];
  const { nodes, marks } = schema;
  if (options.typography) rules.push(...smartQuotes, ellipsis, emDash);
  if (options.markdown !== false) {
    if (nodes.blockquote)
      rules.push(wrappingInputRule(/^\s*>\s$/, nodes.blockquote));
    if (nodes.ordered_list) {
      rules.push(
        wrappingInputRule(
          /^(\d+)\.\s$/,
          nodes.ordered_list,
          (match) => ({ order: Number(match[1]) }),
          (match, node) =>
            node.childCount + Number(node.attrs.order) === Number(match[1]),
        ),
      );
    }
    const task = taskRule(schema);
    if (task) rules.push(task);
    if (nodes.bullet_list)
      rules.push(wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list));
    if (nodes.code_block) {
      rules.push(
        textblockTypeInputRule(
          /^```([^\s`]*)\s$/,
          nodes.code_block,
          (match) => ({
            params: match[1] ?? '',
          }),
        ),
      );
    }
    if (nodes.heading) {
      rules.push(
        textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (match) => ({
          level: match[1].length,
        })),
      );
    }
    if (nodes.horizontal_rule) rules.push(ruleRule(nodes.horizontal_rule));
    // strong before em: `**x*` must not become italic on its way to bold
    if (marks.strong) {
      rules.push(
        markRule(/(?:^|[^*\\])(\*\*(?!\s)([^*]+?)(?<!\s)\*\*)$/, marks.strong),
        markRule(
          /(?:^|[^_\\\p{L}\p{N}])(__(?!\s)([^_]+?)(?<!\s)__)$/u,
          marks.strong,
        ),
      );
    }
    if (marks.em) {
      rules.push(
        markRule(/(?:^|[^*\\])(\*(?!\s)([^*]+?)(?<!\s)\*)$/, marks.em),
        markRule(/(?:^|[^_\\\p{L}\p{N}])(_(?!\s)([^_]+?)(?<!\s)_)$/u, marks.em),
      );
    }
    if (marks.code)
      rules.push(markRule(/(?:^|[^`\\])(`([^`]+)`)$/, marks.code));
    if (marks.strike) {
      rules.push(
        markRule(/(?:^|[^~\\])(~~(?!\s)([^~]+?)(?<!\s)~~)$/, marks.strike),
      );
    }
  }
  return inputRules({ rules });
}
