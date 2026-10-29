// What the Attributes pane completes as it is typed: an attribute's name,
// and its value from what the value can mean in this document.
//
// The completions are worked out from the document rather than from a
// list, where the document can say:
//
//  - `class`: the classes some rule of the page's would match the element
//    with, were it to carry them (`HtmlHandle.namesThatStyle`) — not every
//    class the sheets name, most of which would style nothing here;
//  - `id`: the ids a rule would style it under, and the ids other elements
//    refer to that no element has;
//  - an attribute that names other elements by id — `for`,
//    `aria-labelledby`, `popovertarget` and their kin — the ids of the
//    elements it may name: a label's `for` a control's, a `list` a
//    `<datalist>`'s, `aria-labelledby` an element with text to read;
//  - `href`, a fragment of the document's;
//  - `style`, the properties a declaration may set.
//
// The rest are the values HTML and ARIA enumerate.
import type { Element, HtmlHandle } from '../../../src/html/index.js';

export interface Suggestion {
  /** What it puts in the field. */
  text: string;
  /** A word on what it is: the element an id is of, say. */
  hint?: string;
}

/** How a value is completed: as one value, or a token at a time — the last
 *  of a list split by `separator`. */
export interface Completion {
  items: readonly Suggestion[];
  separator: RegExp | null;
}

const NONE: Completion = { items: [], separator: null };

const SPACES = /\s+/;
const SEMICOLONS = /;\s*/;

// --- what the document knows -------------------------------------------------

function* elementsOf(node: { children?: unknown[] }): Generator<Element> {
  for (const child of (node.children ?? []) as Element[]) {
    if (
      child.type === 'tag' ||
      child.type === 'script' ||
      child.type === 'style'
    ) {
      yield child;
      yield* elementsOf(child);
    }
  }
}

const textSnippet = (el: Element): string => {
  let text = '';
  const walk = (node: {
    children?: unknown[];
    data?: string;
    type?: string;
  }) => {
    if (text.length > 40) return;
    if (node.type === 'text') text += node.data ?? '';
    for (const child of (node.children ?? []) as never[]) walk(child);
  };
  walk(el as never);
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
};

/** An element as a hint names it: its tag, and the start of its text. */
const describe = (el: Element): string => {
  const text = textSnippet(el);
  return text ? `<${el.name}> ${text}` : `<${el.name}>`;
};

/** The attributes that name other elements by id, and what each may name. */
const IDREFS: Record<string, (el: Element) => boolean> = {
  for: (el) =>
    /^(?:input|select|textarea|button|meter|output|progress)$/.test(el.name),
  form: (el) => el.name === 'form',
  list: (el) => el.name === 'datalist',
  headers: (el) => el.name === 'th',
  popovertarget: (el) => 'popover' in el.attribs,
  commandfor: () => true,
  anchor: () => true,
  itemref: () => true,
  'aria-labelledby': (el) => textSnippet(el) !== '',
  'aria-describedby': (el) => textSnippet(el) !== '',
  'aria-controls': () => true,
  'aria-owns': () => true,
  'aria-flowto': () => true,
  'aria-details': () => true,
  'aria-errormessage': () => true,
  'aria-activedescendant': () => true,
};

/** Those of them that take a list of ids. */
const IDREF_LISTS = new Set([
  'headers',
  'itemref',
  'aria-labelledby',
  'aria-describedby',
  'aria-controls',
  'aria-owns',
  'aria-flowto',
]);

/** The ids elements refer to that no element has: what an `id` may be
 *  meant to be. */
function danglingIds(doc: { children?: unknown[] }): Suggestion[] {
  const ids = new Set<string>();
  const wanted = new Map<string, string>();
  for (const el of elementsOf(doc)) {
    if (el.attribs.id) ids.add(el.attribs.id);
    for (const [name, value] of Object.entries(el.attribs)) {
      if (!(name in IDREFS)) continue;
      for (const id of value.split(SPACES)) {
        if (id) wanted.set(id, `${name} of <${el.name}>`);
      }
    }
  }
  return [...wanted]
    .filter(([id]) => !ids.has(id))
    .map(([text, hint]) => ({ text, hint: `named by ${hint}` }));
}

// --- what HTML and ARIA enumerate ----------------------------------------------

const BOOLEAN = ['true', 'false'];

const ROLES = [
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'dialog',
  'document',
  'feed',
  'figure',
  'form',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'meter',
  'navigation',
  'none',
  'note',
  'option',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
];

const INPUT_TYPES = [
  'button',
  'checkbox',
  'color',
  'date',
  'datetime-local',
  'email',
  'file',
  'hidden',
  'image',
  'month',
  'number',
  'password',
  'radio',
  'range',
  'reset',
  'search',
  'submit',
  'tel',
  'text',
  'time',
  'url',
  'week',
];

/** The values an attribute takes from a list, where it has one. */
function enumerated(el: Element, name: string): string[] | null {
  if (name === 'type') {
    if (el.name === 'input') return INPUT_TYPES;
    if (el.name === 'button') return ['submit', 'reset', 'button'];
    if (el.name === 'ol') return ['1', 'a', 'A', 'i', 'I'];
    if (el.name === 'script') return ['module', 'importmap', 'text/javascript'];
    return null;
  }
  if (name.startsWith('aria-')) {
    switch (name) {
      case 'aria-live':
        return ['polite', 'assertive', 'off'];
      case 'aria-current':
        return ['page', 'step', 'location', 'date', 'time', 'true', 'false'];
      case 'aria-haspopup':
        return ['true', 'false', 'menu', 'listbox', 'tree', 'grid', 'dialog'];
      case 'aria-autocomplete':
        return ['inline', 'list', 'both', 'none'];
      case 'aria-orientation':
        return ['horizontal', 'vertical'];
      case 'aria-sort':
        return ['ascending', 'descending', 'none', 'other'];
      case 'aria-checked':
      case 'aria-pressed':
        return ['true', 'false', 'mixed'];
      case 'aria-invalid':
        return ['true', 'false', 'grammar', 'spelling'];
      case 'aria-label':
      case 'aria-roledescription':
      case 'aria-placeholder':
      case 'aria-valuetext':
      case 'aria-keyshortcuts':
        return null;
      default:
        return /^aria-(?:value|level|pos|set|row|col)/.test(name)
          ? null
          : BOOLEAN;
    }
  }
  switch (name) {
    case 'role':
      return ROLES;
    case 'dir':
      return ['ltr', 'rtl', 'auto'];
    case 'target':
      return ['_blank', '_self', '_parent', '_top'];
    case 'rel':
      return [
        'noopener',
        'noreferrer',
        'nofollow',
        'stylesheet',
        'icon',
        'preload',
        'prefetch',
        'preconnect',
        'modulepreload',
        'canonical',
        'alternate',
        'manifest',
      ];
    case 'loading':
      return ['lazy', 'eager'];
    case 'decoding':
      return ['async', 'sync', 'auto'];
    case 'fetchpriority':
      return ['high', 'low', 'auto'];
    case 'crossorigin':
      return ['anonymous', 'use-credentials'];
    case 'referrerpolicy':
      return [
        'no-referrer',
        'no-referrer-when-downgrade',
        'origin',
        'origin-when-cross-origin',
        'same-origin',
        'strict-origin',
        'strict-origin-when-cross-origin',
        'unsafe-url',
      ];
    case 'contenteditable':
      return ['true', 'false', 'plaintext-only'];
    case 'draggable':
    case 'spellcheck':
      return BOOLEAN;
    case 'translate':
      return ['yes', 'no'];
    case 'hidden':
      return ['', 'until-found'];
    case 'popover':
      return ['auto', 'manual', 'hint'];
    case 'popovertargetaction':
      return ['toggle', 'show', 'hide'];
    case 'inputmode':
      return [
        'none',
        'text',
        'decimal',
        'numeric',
        'tel',
        'search',
        'email',
        'url',
      ];
    case 'enterkeyhint':
      return ['enter', 'done', 'go', 'next', 'previous', 'search', 'send'];
    case 'autocapitalize':
      return ['off', 'none', 'on', 'sentences', 'words', 'characters'];
    case 'autocomplete':
      return [
        'on',
        'off',
        'name',
        'email',
        'username',
        'new-password',
        'current-password',
        'one-time-code',
        'tel',
        'street-address',
        'postal-code',
        'country',
        'organization',
      ];
    case 'method':
    case 'formmethod':
      return ['get', 'post', 'dialog'];
    case 'enctype':
    case 'formenctype':
      return [
        'application/x-www-form-urlencoded',
        'multipart/form-data',
        'text/plain',
      ];
    case 'wrap':
      return ['soft', 'hard'];
    case 'scope':
      return ['row', 'col', 'rowgroup', 'colgroup'];
    case 'preload':
      return ['none', 'metadata', 'auto'];
    case 'sandbox':
      return [
        'allow-scripts',
        'allow-same-origin',
        'allow-forms',
        'allow-popups',
        'allow-modals',
        'allow-downloads',
        'allow-top-navigation',
      ];
    default:
      return null;
  }
}

/** `sandbox` and `rel` are lists, as `class` is. */
const TOKEN_LISTS = new Set(['class', 'rel', 'sandbox']);

// --- the two questions ---------------------------------------------------------

/**
 * What `name`'s value on `el` is completed from. Asking costs a walk of the
 * document, or a match of the page's rules, so it is asked once a field
 * opens rather than at each keystroke (`filtered` narrows it as one types).
 */
export function valueCompletion(
  handle: HtmlHandle,
  el: Element,
  name: string,
): Completion {
  const doc = handle.document;
  if (!doc) return NONE;
  if (name === 'class') {
    return {
      items: handle.namesThatStyle(el, 'class').map((text) => ({
        text,
        hint: 'a rule would style it',
      })),
      separator: SPACES,
    };
  }
  if (name === 'id') {
    const styled = handle.namesThatStyle(el, 'id').map((text) => ({
      text,
      hint: 'a rule would style it',
    }));
    const seen = new Set(styled.map((s) => s.text));
    return {
      items: [...styled, ...danglingIds(doc).filter((s) => !seen.has(s.text))],
      separator: null,
    };
  }
  const names = IDREFS[name];
  if (names) {
    const items: Suggestion[] = [];
    for (const other of elementsOf(doc)) {
      const id = other.attribs.id;
      if (!id || other === el || !names(other)) continue;
      items.push({ text: id, hint: describe(other) });
    }
    return { items, separator: IDREF_LISTS.has(name) ? SPACES : null };
  }
  if (name === 'href' || name === 'src' || name === 'action') {
    if (name !== 'href') return NONE;
    const items: Suggestion[] = [];
    for (const other of elementsOf(doc)) {
      const id = other.attribs.id;
      if (id) items.push({ text: `#${id}`, hint: describe(other) });
    }
    return { items, separator: null };
  }
  if (name === 'style') {
    const style = handle.computedStyle(el) ?? {};
    return {
      items: Object.keys(style)
        .filter((property) => !property.startsWith('--'))
        .sort()
        .map((text) => ({ text: `${text}: ` })),
      separator: SEMICOLONS,
    };
  }
  const values = enumerated(el, name);
  if (!values) return NONE;
  return {
    items: values.map((text) => ({ text })),
    separator: TOKEN_LISTS.has(name) ? SPACES : null,
  };
}

const GLOBAL_ATTRIBUTES = [
  'id',
  'class',
  'style',
  'title',
  'lang',
  'dir',
  'hidden',
  'tabindex',
  'role',
  'draggable',
  'contenteditable',
  'spellcheck',
  'translate',
  'inert',
  'popover',
  'autofocus',
  'accesskey',
  'slot',
  'part',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-hidden',
  'aria-expanded',
  'aria-controls',
  'aria-current',
  'aria-live',
  'aria-pressed',
  'aria-selected',
  'aria-checked',
  'aria-disabled',
  'aria-haspopup',
  'aria-owns',
  'aria-details',
];

const BY_ELEMENT: Record<string, string[]> = {
  a: ['href', 'target', 'rel', 'download', 'hreflang', 'referrerpolicy'],
  img: [
    'src',
    'alt',
    'srcset',
    'sizes',
    'width',
    'height',
    'loading',
    'decoding',
  ],
  input: [
    'type',
    'name',
    'value',
    'placeholder',
    'required',
    'disabled',
    'checked',
    'readonly',
    'min',
    'max',
    'step',
    'pattern',
    'autocomplete',
    'list',
    'form',
    'inputmode',
    'enterkeyhint',
    'maxlength',
    'minlength',
    'size',
  ],
  button: [
    'type',
    'name',
    'value',
    'disabled',
    'form',
    'popovertarget',
    'commandfor',
    'command',
  ],
  label: ['for'],
  form: ['action', 'method', 'enctype', 'target', 'novalidate', 'autocomplete'],
  select: ['name', 'multiple', 'size', 'required', 'disabled', 'form'],
  option: ['value', 'selected', 'disabled', 'label'],
  textarea: [
    'name',
    'rows',
    'cols',
    'placeholder',
    'required',
    'disabled',
    'readonly',
    'wrap',
    'maxlength',
  ],
  iframe: [
    'src',
    'srcdoc',
    'name',
    'sandbox',
    'allow',
    'loading',
    'width',
    'height',
  ],
  video: [
    'src',
    'poster',
    'controls',
    'autoplay',
    'muted',
    'loop',
    'playsinline',
    'preload',
    'width',
    'height',
  ],
  audio: ['src', 'controls', 'autoplay', 'muted', 'loop', 'preload'],
  td: ['colspan', 'rowspan', 'headers'],
  th: ['colspan', 'rowspan', 'headers', 'scope', 'abbr'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  details: ['open', 'name'],
  dialog: ['open'],
  link: ['rel', 'href', 'media', 'type', 'as', 'crossorigin', 'sizes'],
  script: [
    'src',
    'type',
    'async',
    'defer',
    'nomodule',
    'crossorigin',
    'integrity',
  ],
  meta: ['name', 'content', 'charset', 'http-equiv', 'property'],
};

/** The names the add form offers for `el`: what HTML gives it and every
 *  element, the `data-` attributes the document uses elsewhere, and none
 *  it has. */
export function nameCompletion(
  handle: HtmlHandle,
  el: Element,
): readonly Suggestion[] {
  const out = new Map<string, Suggestion>();
  for (const name of BY_ELEMENT[el.name] ?? []) {
    out.set(name, { text: name, hint: `<${el.name}>` });
  }
  for (const name of GLOBAL_ATTRIBUTES) {
    if (!out.has(name)) out.set(name, { text: name });
  }
  if (handle.document) {
    for (const other of elementsOf(handle.document)) {
      for (const name of Object.keys(other.attribs)) {
        if (name.startsWith('data-') && !out.has(name)) {
          out.set(name, { text: name, hint: 'used in the page' });
        }
      }
    }
  }
  for (const name of Object.keys(el.attribs)) out.delete(name);
  return [...out.values()];
}

/** How many suggestions a list shows. */
const MOST_SHOWN = 12;

/** The last token of `value`, where it is a list: what is being typed. */
export function typing(value: string, separator: RegExp | null): string {
  if (!separator) return value;
  const parts = value.split(separator);
  return parts[parts.length - 1] ?? '';
}

/**
 * The suggestions for what is typed: those starting with it first, then
 * those containing it, case aside, and none a list already holds.
 */
export function filtered(
  completion: Completion,
  value: string,
): readonly Suggestion[] {
  const word = typing(value, completion.separator).toLowerCase();
  const taken = completion.separator
    ? new Set(value.split(completion.separator).slice(0, -1))
    : new Set<string>();
  const starts: Suggestion[] = [];
  const contains: Suggestion[] = [];
  for (const item of completion.items) {
    if (taken.has(item.text)) continue;
    const text = item.text.toLowerCase();
    if (text === word) continue;
    if (text.startsWith(word)) starts.push(item);
    else if (word && text.includes(word)) contains.push(item);
    if (starts.length >= MOST_SHOWN) break;
  }
  return [...starts, ...contains].slice(0, MOST_SHOWN);
}

/** `value` with what is being typed replaced by `text`. */
export function accept(
  value: string,
  separator: RegExp | null,
  text: string,
): string {
  if (!separator) return text;
  const word = typing(value, separator);
  const kept = value.slice(0, value.length - word.length);
  return kept + text;
}
