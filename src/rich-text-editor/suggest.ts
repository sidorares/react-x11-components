// Suggestions: a list that opens at a trigger character as it is typed — `@`
// for people, `#` for issues, `:` for emoji, `/` for a block menu — kept by a
// plugin and drawn by `<RichTextEditor>`.
//
// The division of labour is ProseMirror's own, and it is what keeps the list
// working on every rung of the ladder (docs/prd-rich-text-editor.md):
//
// - **The plugin holds the state**: which trigger is open, what has been
//   typed after it, the rows that answer it and the highlighted one — all of
//   it plugin state, changed only by transactions. An app that owns the
//   EditorState sees the list change like anything else, and a re-render
//   cannot lose it, because a render is not where it lives.
// - **The plugin takes the keys**, through `handleKeyDown`, and only while
//   rows are showing: Up and Down move the highlight, Enter and Tab take the
//   row, Escape closes the list. It sits ahead of the default keymap, so
//   Enter takes a row instead of splitting the paragraph.
// - **The plugin asks for the rows**, from its plugin view: a list is
//   filtered here, a function is called, and an answer to a query the user
//   has since typed past is dropped — `<CodeEditor>`'s completion rule, for
//   the same reason.
// - **The component draws**, from nothing but this state: a `<popup>` hung
//   off the trigger, whose rows run `acceptSuggestion`.
//
// When a list opens is the decision with a user-visible edge: **as the
// trigger's word is typed, never as the caret moves.** The value is markdown,
// so a mention stays text (`@ada`), and a document is soon full of words that
// start with a trigger. Opening whenever the caret visits one would pop a list
// up at every click; opening on an edit at the caret is the rule GitHub's
// comment box keeps, and `<CodeEditor>`'s completion.
import type { ReactNode } from 'react';
import { closeHistory } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, Selection, TextSelection } from 'prosemirror-state';
import type { Command, EditorState, Transaction } from 'prosemirror-state';
import { StepMap } from 'prosemirror-transform';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorView } from 'prosemirror-view';

/** One row of a suggestion list. */
export interface SuggestionItem {
  /** What the row shows — and, in a list the editor filters, what the query
   *  is matched against. */
  label: string;
  /** Muted text after the label: a handle, a description, a shortcut. */
  detail?: string;
  /**
   * What replaces the trigger and the query: text, or a node of the
   * document's schema — text carrying a link mark, say, or a mention node of
   * an app's own schema. Default: the trigger and the label, `@Ada`. A space
   * follows it, unless one already does.
   */
  insert?: string | PMNode;
  /**
   * Run instead of inserting anything, on the state the trigger and the
   * query have been deleted from — a block menu's "Heading 1". What it
   * dispatches joins the deletion, so the choice is one undo step.
   */
  command?: Command;
}

/** What a suggester's `items` function is asked with. */
export interface SuggestionQuery {
  /** What has been typed after the trigger. */
  query: string;
  /** The trigger. */
  char: string;
  /** The state the query was read from — for its schema, to build a node. */
  state: EditorState;
}

/** What `renderItem` is handed beside its row. */
export interface SuggestionRow {
  /** The highlighted row — the one Enter takes — drawn on the accent. */
  selected: boolean;
  /** What has been typed after the trigger. */
  query: string;
}

/**
 * A trigger character, and where the rows it opens come from. `Item` is the
 * app's own row type when a row carries more than a label — an avatar, a
 * presence — for `renderItem` to draw.
 */
export interface Suggester<Item extends SuggestionItem = SuggestionItem> {
  /** What opens the list: `'@'`, `'#'`, `':'`, `'/'`. */
  char: string;
  /**
   * The rows. An array is filtered by what has been typed — labels that
   * start with it first, then labels with a word that does, then any that
   * contain it. A function is called with each new query and its rows are
   * shown as given; it may answer with a promise, and an answer that comes
   * after the query has moved on is dropped.
   */
  items:
    | readonly Item[]
    | ((query: SuggestionQuery) => readonly Item[] | Promise<readonly Item[]>);
  /**
   * A row of the app's own, in place of the label and its detail: an avatar,
   * a presence dot, a shortcut drawn as keys. The editor still draws the
   * highlight behind it and takes a press on it, and an array is still
   * filtered on the label.
   */
  renderItem?(item: Item, row: SuggestionRow): ReactNode;
  /** Only at the very start of a textblock — a block menu. Default false:
   *  at the start of any word. */
  startOfLine?: boolean;
  /** The query may have spaces in it — a full name. Default false: a space
   *  ends it. Two spaces in a row end it either way. */
  allowSpaces?: boolean;
}

/** An open list — what `suggestionState` answers and the component draws. */
export interface SuggestionState {
  /** Which suggester opened it: an index into the plugin's list. */
  readonly index: number;
  readonly char: string;
  /** What has been typed after the trigger — the whole word the caret is
   *  in, so a row taken mid-word replaces all of it. */
  readonly query: string;
  /** The trigger and the query, in the document: what a row replaces. */
  readonly from: number;
  readonly to: number;
  /** The rows — null until the first answer comes. */
  readonly items: readonly SuggestionItem[] | null;
  /** The highlighted row. */
  readonly selected: number;
}

interface PluginState {
  active: SuggestionState | null;
  /** Where a list was closed — by Escape, or by a choice. A trigger at one
   *  of these positions does not open again while its character is there. */
  closed: readonly number[];
}

type Meta =
  | {
      type: 'items';
      index: number;
      from: number;
      query: string;
      items: readonly SuggestionItem[];
    }
  | { type: 'select'; index: number }
  | { type: 'close' };

const key = new PluginKey<PluginState>('suggestions');

/** Rows to a page: PageUp and PageDown move by it, and the list shows it. */
export const SUGGESTION_PAGE = 8;
/** The most rows a list keeps. */
const MAX_ITEMS = 100;
/** How many closed triggers are remembered. */
const MAX_CLOSED = 16;

// --- where a list opens --------------------------------------------------------

/** An inline leaf — an image, a line break — in a textblock's text. */
const LEAF = '￼';
/** What a trigger may follow: the start of the block, a space, an inline
 *  leaf, or opening punctuation — so `ada@example.com` is an address. */
const BEFORE_TRIGGER = /[\s￼([{<"'“‘«]/u;
/** What ends a query that may not hold spaces. */
const WORD_END = /[\s￼]/u;

interface Match {
  index: number;
  char: string;
  query: string;
  from: number;
  to: number;
}

/** Has what was typed after a trigger stopped being a query? */
function queryEnded(typed: string, spaces: boolean): boolean {
  if (typed.includes(LEAF)) return true;
  if (!spaces) return WORD_END.test(typed);
  return /^\s|\s\s|\n/u.test(typed);
}

/**
 * The trigger whose word the caret is in, if any: for each suggester, the
 * nearest occurrence of its character before the caret, where a word can
 * start, with nothing between it and the caret that ends a query — and
 * outside code, where `@` is a character. The nearest of those wins.
 */
function findMatch(
  state: EditorState,
  suggesters: readonly Suggester[],
): Match | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return null;
  const $head = sel.$head;
  const block = $head.parent;
  if (!block.isTextblock || block.type.spec.code) return null;
  const text = block.textBetween(0, block.content.size, undefined, LEAF);
  const caret = $head.parentOffset;
  const start = $head.start();
  let best: Match | null = null;
  for (let index = 0; index < suggesters.length; index++) {
    const s = suggesters[index];
    const char = s.char;
    if (!char || caret < char.length) continue;
    const at = text.lastIndexOf(char, caret - char.length);
    if (at < 0 || (best && start + at <= best.from)) continue;
    if (s.startOfLine ? at !== 0 : at > 0 && !BEFORE_TRIGGER.test(text[at - 1]))
      continue;
    const spaces = !!s.allowSpaces;
    if (queryEnded(text.slice(at + char.length, caret), spaces)) continue;
    if (block.childAfter(at).node?.marks.some((m) => m.type.spec.code))
      continue;
    // without spaces the query is the whole word, the part past the caret
    // too; with them it is what has been typed so far
    let end = caret;
    if (!spaces) {
      while (
        end < text.length &&
        !WORD_END.test(text[end]) &&
        !text.startsWith(char, end)
      )
        end++;
    }
    best = {
      index,
      char,
      query: text.slice(at + char.length, end),
      from: start + at,
      to: start + end,
    };
  }
  return best;
}

/** Did `tr` change the document between `from` and `to` — positions in the
 *  document it made? A deletion there counts: it leaves an empty range. */
function editedBetween(tr: Transaction, from: number, to: number): boolean {
  if (!tr.docChanged) return false;
  const { maps } = tr.mapping;
  for (let i = 0; i < maps.length; i++) {
    const later = tr.mapping.slice(i + 1);
    let hit = false;
    maps[i].forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (later.map(newStart, -1) <= to && later.map(newEnd, 1) >= from)
        hit = true;
    });
    if (hit) return true;
  }
  return false;
}

function nextState(
  tr: Transaction,
  prev: PluginState,
  state: EditorState,
  suggesters: readonly Suggester[],
): PluginState {
  const meta = tr.getMeta(key) as Meta | undefined;
  let closed = prev.closed;
  let active = prev.active;
  if (tr.docChanged) {
    // a closed trigger goes with its character; the open one follows its own
    closed = closed.flatMap((pos) => {
      const r = tr.mapping.mapResult(pos);
      return r.deletedAfter ? [] : [r.pos];
    });
    if (active) {
      const r = tr.mapping.mapResult(active.from);
      active = r.deletedAfter ? null : { ...active, from: r.pos };
    }
  }
  if (meta?.type === 'close') {
    // where the trigger was — or, when a choice replaced it, where what
    // replaced it starts, so a mention that begins with its own trigger does
    // not reopen on itself
    if (prev.active) {
      closed = [...closed, tr.mapping.map(prev.active.from, -1)].slice(
        -MAX_CLOSED,
      );
    }
    return { active: null, closed };
  }
  const match = findMatch(state, suggesters);
  if (!match || closed.includes(match.from)) {
    return !prev.active && closed === prev.closed
      ? prev
      : { active: null, closed };
  }
  const same =
    !!active && active.from === match.from && active.index === match.index;
  // a new list opens on an edit in its word, and not on an edit that is not
  // the user's — a reset, a collaborator's change
  if (
    !same &&
    (tr.getMeta('addToHistory') === false ||
      !editedBetween(tr, match.from, match.to))
  ) {
    return { active: null, closed };
  }
  let items = same ? active!.items : null;
  let selected = same && active!.query === match.query ? active!.selected : 0;
  if (
    meta?.type === 'items' &&
    meta.index === match.index &&
    meta.from === match.from &&
    meta.query === match.query
  ) {
    items = meta.items;
    selected = 0;
  } else if (meta?.type === 'select') {
    selected = meta.index;
  }
  if (items) selected = Math.max(0, Math.min(selected, items.length - 1));
  return { active: { ...match, items, selected }, closed };
}

// --- the rows ------------------------------------------------------------------

/**
 * A list, by what has been typed: labels that start with it (as typed, then
 * in any case), then labels with a later word that does, then labels that
 * merely contain it — in the list's own order within each. What the editor
 * does with a suggester whose `items` is an array; exported for an app that
 * filters its own.
 */
export function filterSuggestions<Item extends SuggestionItem>(
  items: readonly Item[],
  query: string,
): Item[] {
  if (!query) return items.slice(0, MAX_ITEMS);
  const folded = query.toLowerCase();
  const ranked: Array<{ item: Item; rank: number; order: number }> = [];
  items.forEach((item, order) => {
    const label = item.label;
    const lower = label.toLowerCase();
    if (!lower.includes(folded)) return;
    const rank = label.startsWith(query)
      ? 0
      : lower.startsWith(folded)
        ? 1
        : lower.split(/[\s\-_./@#]+/u).some((word) => word.startsWith(folded))
          ? 2
          : 3;
    ranked.push({ item, rank, order });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return ranked.slice(0, MAX_ITEMS).map((r) => r.item);
}

/** The plugin view: asks for the rows whenever the query changes, and hands
 *  back the answer to the query that is still open — no other. */
function asker(
  view: EditorView,
  get: () => readonly Suggester[],
): { update(): void; destroy(): void } {
  let asked = '';
  let serial = 0;
  const ask = (): void => {
    const active = key.getState(view.state)?.active ?? null;
    if (!active) {
      asked = '';
      return;
    }
    const stamp = `${active.index} ${active.from} ${active.query}`;
    if (stamp === asked) return;
    asked = stamp;
    const id = ++serial;
    const suggester = get()[active.index];
    if (!suggester) return;
    const { index, from, query, char } = active;
    const state = view.state;
    // always a turn later, answered or not: rows land in a transaction of
    // their own, never inside the one being applied
    Promise.resolve()
      .then(() =>
        // a query typed past before its turn came is never asked at all
        id !== serial
          ? null
          : typeof suggester.items === 'function'
            ? suggester.items({ query, char, state })
            : filterSuggestions(suggester.items, query),
      )
      .then((items) => {
        if (!items || id !== serial || view.isDestroyed) return;
        const now = key.getState(view.state)?.active;
        if (
          !now ||
          now.index !== index ||
          now.from !== from ||
          now.query !== query
        )
          return;
        const meta: Meta = {
          type: 'items',
          index,
          from,
          query,
          items: items.slice(0, MAX_ITEMS),
        };
        view.dispatch(view.state.tr.setMeta(key, meta));
      })
      // a source that throws has nothing to suggest
      .catch(() => {});
  };
  ask();
  return {
    update: ask,
    destroy: () => {
      serial++;
    },
  };
}

// --- the commands ----------------------------------------------------------------

/** The open list, or null — what `<RichTextEditor>` draws its popup from,
 *  and what an app drawing its own reads. */
export function suggestionState(state: EditorState): SuggestionState | null {
  return key.getState(state)?.active ?? null;
}

/** The suggester whose list is open, or null — for its `renderItem`. */
export function suggesterFor(state: EditorState): Suggester | null {
  const active = suggestionState(state);
  if (!active) return null;
  const get = key.get(state)?.spec.suggesters as
    (() => readonly Suggester[]) | undefined;
  return get?.()[active.index] ?? null;
}

/** Close the list. It does not open again for this trigger while the
 *  trigger is there; typing a new one opens a new list. */
export const dismissSuggestion: Command = (state, dispatch) => {
  if (!suggestionState(state)) return false;
  dispatch?.(state.tr.setMeta(key, { type: 'close' } satisfies Meta));
  return true;
};

/** Highlight row `index`, held to the rows there are. */
export function selectSuggestion(index: number): Command {
  return (state, dispatch) => {
    const active = suggestionState(state);
    if (!active?.items?.length) return false;
    const to = Math.max(0, Math.min(index, active.items.length - 1));
    if (to !== active.selected)
      dispatch?.(state.tr.setMeta(key, { type: 'select', index: to }));
    return true;
  };
}

/** A command's transaction, made on the state after `tr`, as part of `tr`. */
function join(tr: Transaction, inner: Transaction): void {
  for (const step of inner.steps) tr.step(step);
  if (inner.selectionSet)
    tr.setSelection(inner.selection.map(tr.doc, StepMap.empty));
  if (inner.storedMarksSet) tr.setStoredMarks(inner.storedMarks);
  if (inner.scrolledIntoView) tr.scrollIntoView();
}

/**
 * Take a row — the highlighted one, unless `index` says which. Its `insert`
 * (or the trigger and its label) replaces the trigger and the query, with a
 * space after it; or its `command` runs where they were.
 */
export function acceptSuggestion(index?: number): Command {
  return (state, dispatch, view) => {
    const active = suggestionState(state);
    const item = active?.items?.[index ?? active.selected];
    if (!active || !item) return false;
    if (!dispatch) return true;
    const { from, to } = active;
    // its own undo step: undoing a choice gives back what was typed, however
    // soon after the typing it came
    const tr = closeHistory(
      state.tr.setMeta(key, { type: 'close' } satisfies Meta),
    );
    if (item.command) {
      tr.delete(from, to);
      const run = item.command;
      const { state: after, transactions } = state.applyTransaction(tr);
      if (transactions.length > 1) {
        // another plugin appended to the deletion, so the command's state is
        // not `tr`'s document and its steps cannot join: two steps, then.
        // `after` is what applying `tr` makes — the view's next state, or
        // the one an app that owns the state hands back — so the command's
        // transaction applies after `tr` on either.
        dispatch(tr);
        run(after, dispatch, view);
        return true;
      }
      let joined = false;
      run(
        after,
        (inner) => {
          if (joined || inner.before !== tr.doc) return;
          joined = true;
          join(tr, inner);
        },
        view,
      );
      dispatch(tr.scrollIntoView());
      return true;
    }
    const insert = item.insert ?? active.char + item.label;
    if (typeof insert === 'string') tr.insertText(insert, from, to);
    else tr.replaceRangeWith(from, to, insert);
    const end = tr.mapping.map(to);
    const $end = tr.doc.resolve(end);
    if ($end.parent.inlineContent) {
      // the way a word ends: with a space, or the one already after it
      const next = $end.nodeAfter;
      if (!(next?.isText && /^\s/u.test(next.text ?? '')))
        tr.insertText(' ', end);
      tr.setSelection(TextSelection.create(tr.doc, end + 1));
    } else {
      tr.setSelection(Selection.near($end));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

// --- the plugin --------------------------------------------------------------------

/** Plain keys only, and only while rows are showing: a chord, or Shift with
 *  an arrow, is still the editor's. */
function keyDown(view: EditorView, event: KeyboardEvent): boolean {
  const active = suggestionState(view.state);
  if (!active?.items?.length || !view.editable) return false;
  const e = event as unknown as {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
  };
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
  const move = (by: number): boolean =>
    selectSuggestion(active.selected + by)(view.state, view.dispatch);
  switch (e.key) {
    case 'ArrowDown':
      return move(1);
    case 'ArrowUp':
      return move(-1);
    case 'PageDown':
      return move(SUGGESTION_PAGE);
    case 'PageUp':
      return move(-SUGGESTION_PAGE);
    case 'Enter':
    case 'Tab':
      return acceptSuggestion()(view.state, view.dispatch, view);
    case 'Escape':
      return dismissSuggestion(view.state, view.dispatch);
  }
  return false;
}

/**
 * The suggestion plugin — one per editor, holding every trigger. It goes
 * ahead of the default plugins, so its keys come before the keymap's:
 * `<RichTextEditor suggestions>` puts it there itself, and an app that owns
 * the state writes `plugins: [suggestions([…]), ...defaultPlugins(schema)]`.
 *
 * `suggesters` may be a function that returns them, read whenever they are
 * needed — how the component hands over a prop that may be a new array on
 * every render without the plugin, and the list that is open, being rebuilt.
 * While a trigger's word is being typed its text carries the decoration
 * class `suggestion`, which the editor draws in the accent colour.
 */
export function suggestions(
  suggesters: readonly Suggester[] | (() => readonly Suggester[]),
): Plugin {
  const get = typeof suggesters === 'function' ? suggesters : () => suggesters;
  return new Plugin<PluginState>({
    key,
    // read back by `suggesterFor`, so a row is drawn by its suggester's
    // `renderItem` in an app-owned state too
    suggesters: get,
    state: {
      init: () => ({ active: null, closed: [] }),
      apply: (tr, prev, _old, state) => nextState(tr, prev, state, get()),
    },
    props: {
      handleKeyDown: keyDown,
      decorations(state) {
        const active = suggestionState(state);
        return active
          ? DecorationSet.create(state.doc, [
              Decoration.inline(active.from, active.to, {
                class: 'suggestion',
              }),
            ])
          : null;
      },
    },
    view: (view) => asker(view, get),
  });
}
