// Forms: what a submission carries, where it goes, and how it is encoded.
//
// Submitting a form is following a link the form writes. `<Html>` works the
// link out — the entry list HTML builds from the form's controls (HTML
// 4.10.21.4, "constructing the entry list"), encoded as the form's `enctype`
// says, for its `action` resolved against the document's base, by its
// `method` — and hands it to `onSubmit`, as it hands a link's `href` to
// `onLink`. It sends nothing: whether a POST goes anywhere is the host's to
// decide, as whether an image loads is.
//
// Pure, and asked of a DOM with no display: which controls belong to which
// form, which of them a submission carries and what Enter in a field does are
// where the subtle bugs are, and none of it needs a widget.
//
// What a control holds *now* is the one thing the markup does not say. A
// typed text is the widget's, and `FormState` keeps it for the submission and
// for the widget's next mount; a checkbox, a radio and a `<select>` keep
// theirs in the DOM's attributes, where `:checked` reads them, and
// `FormState` remembers what those attributes were so a reset can put them
// back.
import type { AnyNode, Element } from 'domhandler';

import { attr, childrenOf, elementsIn, isElement, tagOf } from './dom.js';
import { resolveUrl } from './url.js';

export type FormMethod = 'get' | 'post';

export type FormEnctype =
  'application/x-www-form-urlencoded' | 'multipart/form-data' | 'text/plain';

/** A form, submitted: everything a host needs to make the request. */
export interface FormSubmission {
  /** The `<form>`. */
  form: Element;
  /**
   * The button that submitted it — a submit `<button>`, an `<input
   * type=submit>` or an `<input type=image>` — or null for Enter in a form
   * that has none.
   */
  submitter: Element | null;
  method: FormMethod;
  /**
   * Where the request goes: the action, resolved against the document's
   * base, and for a GET with the entries as its query — so a GET is a link
   * to exactly this.
   */
  url: string;
  enctype: FormEnctype;
  /** The name–value pairs the form carries, in tree order, unencoded. A
   *  file field's value is the name of its file: always empty here. */
  entries: [name: string, value: string][];
  /** A POST's body, encoded as `enctype` says; null for a GET. */
  body: string | null;
  /** The `Content-Type` a POST's body goes with — `multipart/form-data`'s
   *  names its boundary; null for a GET. */
  contentType: string | null;
  /**
   * The browsing context it asked for: `formtarget` on the button, `target`
   * on the form, or `<base target>`. `'_blank'` is a new one; empty is the
   * one the document is in.
   */
  target: string;
}

/** Where a submission's relative URLs resolve, and the document it leaves. */
export interface SubmitContext {
  /** What the document's relative URLs resolve against: its `<base href>`,
   *  or the URL it came from. */
  base: string | null;
  /** The URL the document came from — an empty `action` is it (HTML
   *  4.10.21.3, step 11), not its base. Defaults to `base`. */
  documentUrl?: string | null;
  /** What a text control holds now, where that is not what its markup
   *  says: typed text. `undefined` is "what the markup says". */
  live?: (el: Element) => string | undefined;
  /** Where an `<input type=image>` submitter was pressed, in CSS pixels
   *  from its top left. */
  point?: { x: number; y: number };
  /** `multipart/form-data`'s boundary. Made up when absent; a test pins it. */
  boundary?: string;
}

// --- which controls, in which form ---------------------------------------------

/** The elements that can be submitted (HTML 4.10.2, "submittable"). */
const SUBMITTABLE = new Set(['button', 'input', 'select', 'textarea']);

/** Every `<input type>` HTML knows. Any other type, or none, is a text
 *  field. */
const INPUT_TYPES = new Set([
  'hidden',
  'text',
  'search',
  'tel',
  'url',
  'email',
  'password',
  'date',
  'month',
  'week',
  'time',
  'datetime-local',
  'number',
  'range',
  'color',
  'checkbox',
  'radio',
  'file',
  'submit',
  'image',
  'reset',
  'button',
]);

/** The fields that make Enter in a form with no submit button do nothing
 *  when there is more than one of them (HTML 4.10.21.2). */
const BLOCKS_IMPLICIT = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'date',
  'month',
  'week',
  'time',
  'datetime-local',
  'number',
]);

/** An `<input>`'s type state: its `type`, lowercased, or `text` where it
 *  names none HTML knows. */
export function inputType(el: Element): string {
  const type = (attr(el, 'type') ?? '').trim().toLowerCase();
  return INPUT_TYPES.has(type) ? type : 'text';
}

/**
 * What pressing a control does: submits its form, resets it, nothing
 * (`'button'`) — or null for something that is not a button at all. A
 * `<button>` with no `type`, or one HTML does not know, submits.
 */
export function buttonType(el: Element): 'submit' | 'reset' | 'button' | null {
  const tag = tagOf(el);
  if (tag === 'button') {
    const type = (attr(el, 'type') ?? '').trim().toLowerCase();
    return type === 'reset' || type === 'button' ? type : 'submit';
  }
  if (tag !== 'input') return null;
  const type = inputType(el);
  if (type === 'submit' || type === 'image') return 'submit';
  if (type === 'reset' || type === 'button') return type;
  return null;
}

/** The top of the tree an element is in: its document. */
export function rootOf(el: AnyNode): AnyNode {
  let at: AnyNode = el;
  while (at.parent) at = at.parent;
  return at;
}

/**
 * The form a control belongs to (HTML 4.10.17.3): the one its `form`
 * attribute names by id, or else the nearest `<form>` around it. A `form`
 * attribute that names nothing, or names something that is not a form,
 * leaves it with none — it does not fall back to the form around it.
 */
export function formOwner(
  el: Element,
  root: AnyNode = rootOf(el),
): Element | null {
  return ownerOf(el, root, null);
}

function ownerOf(
  el: Element,
  root: AnyNode,
  byId: Map<string, Element> | null,
): Element | null {
  const id = attr(el, 'form');
  if (id !== undefined) {
    const named = byId ? (byId.get(id) ?? null) : elementById(root, id);
    return named && tagOf(named) === 'form' ? named : null;
  }
  for (let at = el.parent; at && isElement(at); at = at.parent) {
    if (tagOf(at) === 'form') return at;
  }
  return null;
}

function elementById(root: AnyNode, id: string): Element | null {
  for (const el of elementsIn(root)) if (attr(el, 'id') === id) return el;
  return null;
}

/**
 * The submittable controls a form owns, in tree order — those inside it and
 * those elsewhere that name it with `form`. Not those in a `<template>`,
 * whose content is inert, or a `<datalist>`, whose are its suggestions.
 */
export function controlsOf(form: Element): Element[] {
  const root = rootOf(form);
  let byId: Map<string, Element> | null = null;
  const out: Element[] = [];
  for (const el of elementsIn(root)) {
    if (!SUBMITTABLE.has(tagOf(el))) continue;
    // one walk for every id, and only when something asks by one
    if (attr(el, 'form') !== undefined && !byId) {
      byId = new Map();
      for (const any of elementsIn(root)) {
        const id = attr(any, 'id');
        if (id !== undefined && !byId.has(id)) byId.set(id, any);
      }
    }
    if (ownerOf(el, root, byId) !== form || inert(el)) continue;
    out.push(el);
  }
  return out;
}

function inert(el: Element): boolean {
  for (let at = el.parent; at && isElement(at); at = at.parent) {
    const tag = tagOf(at);
    if (tag === 'template' || tag === 'datalist') return true;
  }
  return false;
}

/**
 * Whether a control is disabled (HTML 4.10.18.5): by its own `disabled`, or
 * by a disabled `<fieldset>` around it — except inside that fieldset's first
 * `<legend>`, which stays live, so a checkbox there can switch the rest on.
 */
export function isDisabled(el: Element): boolean {
  if (attr(el, 'disabled') !== undefined) return true;
  let child: Element = el;
  for (let at = el.parent; at && isElement(at); at = at.parent) {
    if (
      tagOf(at) === 'fieldset' &&
      attr(at, 'disabled') !== undefined &&
      !(tagOf(child) === 'legend' && firstLegend(at) === child)
    ) {
      return true;
    }
    child = at;
  }
  return false;
}

function firstLegend(fieldset: Element): Element | null {
  for (const child of childrenOf(fieldset)) {
    if (isElement(child) && tagOf(child) === 'legend') return child;
  }
  return null;
}

// --- what each control holds -------------------------------------------------------

/** A `<select>`'s `<option>`s, in tree order, through its `<optgroup>`s. */
export function optionElements(select: Element): Element[] {
  const out: Element[] = [];
  const walk = (node: Element): void => {
    for (const child of childrenOf(node)) {
      if (!isElement(child)) continue;
      const tag = tagOf(child);
      if (tag === 'option') out.push(child);
      else if (tag === 'optgroup' && node === select) walk(child);
    }
  };
  walk(select);
  return out;
}

/** An option's text, its white space collapsed, as HTML's `text` IDL
 *  attribute reads it. */
export function optionLabel(option: Element): string {
  let text = '';
  const walk = (node: AnyNode): void => {
    if (node.type === 'text') text += node.data;
    else for (const child of childrenOf(node)) walk(child);
  };
  walk(option);
  return text.replace(/[\t\n\f\r ]+/g, ' ').trim();
}

/** An option's value: its `value`, or else its text. */
export function optionValue(option: Element): string {
  return attr(option, 'value') ?? optionLabel(option);
}

function optionDisabled(option: Element): boolean {
  if (attr(option, 'disabled') !== undefined) return true;
  const parent = option.parent;
  return (
    !!parent &&
    isElement(parent) &&
    tagOf(parent) === 'optgroup' &&
    attr(parent, 'disabled') !== undefined
  );
}

/** Whether a `<select>` is a list box that takes many options. */
export function isMultiple(select: Element): boolean {
  return attr(select, 'multiple') !== undefined;
}

/**
 * The options a `<select>` has selected. A drop-down one has exactly one
 * where it has any: the last marked `selected`, as the parser leaves it, or
 * else the first that is not disabled (HTML 4.10.7, "selectedness setting").
 * A `multiple` one has those marked, and no default.
 */
export function selectedOptions(select: Element): Element[] {
  const options = optionElements(select);
  const marked = options.filter((o) => attr(o, 'selected') !== undefined);
  if (isMultiple(select)) return marked;
  if (marked.length) return [marked[marked.length - 1]];
  const first = options.find((o) => !optionDisabled(o));
  return first ? [first] : [];
}

/** A `<textarea>`'s text as its markup has it — HTML drops one newline
 *  straight after the open tag, so a pretty-printed one does not start on
 *  a blank line. */
export function textareaDefault(el: Element): string {
  let text = '';
  for (const child of childrenOf(el)) {
    if (child.type === 'text') text += child.data;
  }
  return text.replace(/^\r?\n/, '');
}

/** HTML's valid floating-point number (2.3.4.3): what a number field may
 *  hold, where `1.` and `+1` are not one. */
const FLOAT = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * What a text control holds: typed text where there is some, and else its
 * markup's — a `<textarea>`'s content, an `<input>`'s `value` — put through
 * the type's value sanitization (HTML 4.10.5.1): a single-line field holds no
 * line breaks, an email or a URL no white space at its ends, and a number
 * field nothing that is not a number.
 */
export function controlValue(
  el: Element,
  live?: (el: Element) => string | undefined,
): string {
  const typed = live?.(el);
  if (tagOf(el) === 'textarea') return typed ?? textareaDefault(el);
  const raw = typed ?? attr(el, 'value') ?? '';
  switch (inputType(el)) {
    case 'text':
    case 'search':
    case 'tel':
    case 'password':
      return raw.replace(/[\r\n]/g, '');
    case 'email':
    case 'url':
      return raw
        .replace(/[\r\n]/g, '')
        .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
    case 'number':
      return FLOAT.test(raw) ? raw : '';
    default:
      return raw;
  }
}

// --- the entry list --------------------------------------------------------------

/** One entry, and whether it is a file's — encoded differently in a
 *  multipart body. */
interface Entry {
  name: string;
  value: string;
  file: boolean;
}

/**
 * The entries a form submits (HTML 4.10.21.4): each enabled control it owns
 * that has a name, with its value — the checked checkboxes and radios, a
 * `<select>`'s selected options, the button that submitted it and no other.
 */
function entriesOf(
  form: Element,
  submitter: Element | null,
  live: SubmitContext['live'],
  point: SubmitContext['point'],
): Entry[] {
  const out: Entry[] = [];
  const add = (name: string, value: string, file = false): void => {
    out.push({ name, value, file });
  };
  for (const el of controlsOf(form)) {
    if (isDisabled(el)) continue;
    const tag = tagOf(el);
    const type = tag === 'input' ? inputType(el) : '';
    if (buttonType(el) !== null && el !== submitter) continue;
    if (type === 'image') {
      // an image button is its point, named after it where it has a name
      const name = attr(el, 'name');
      const prefix = name ? `${name}.` : '';
      add(`${prefix}x`, String(Math.round(point?.x ?? 0)));
      add(`${prefix}y`, String(Math.round(point?.y ?? 0)));
      continue;
    }
    const name = attr(el, 'name');
    if (!name) continue;
    if (tag === 'select') {
      for (const option of selectedOptions(el)) {
        if (!optionDisabled(option)) add(name, optionValue(option));
      }
      continue;
    }
    if (type === 'checkbox' || type === 'radio') {
      if (attr(el, 'checked') !== undefined) {
        add(name, attr(el, 'value') ?? 'on');
      }
      continue;
    }
    if (type === 'file') {
      // no file is ever chosen here: the field goes as one with no name
      add(name, '', true);
      continue;
    }
    if (type === 'hidden' && name.toLowerCase() === '_charset_') {
      add(name, 'UTF-8');
      continue;
    }
    if (tag === 'button' || type === 'submit' || type === 'reset') {
      add(name, attr(el, 'value') ?? '');
      continue;
    }
    add(name, controlValue(el, live));
    const dirname = attr(el, 'dirname');
    if (
      dirname &&
      (tag === 'textarea' || type === 'text' || type === 'search')
    ) {
      add(dirname, attr(el, 'dir')?.toLowerCase() === 'rtl' ? 'rtl' : 'ltr');
    }
  }
  return out;
}

// --- encoding ---------------------------------------------------------------------

/** Line breaks as a form sends them: every lone CR and lone LF becomes
 *  CRLF. */
function crlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\r\n');
}

/** A string with no lone surrogates: what encoding it as UTF-8 needs, and
 *  what a USVString is. */
function wellFormed(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '�',
  );
}

/**
 * `application/x-www-form-urlencoded`'s byte serializer over UTF-8 (URL
 * 5.2): letters, digits and `*-._` as they are, a space as `+`, everything
 * else percent-encoded. `encodeURIComponent` spares `!~'()` besides, so
 * those are encoded after it.
 */
function formEncode(text: string): string {
  return encodeURIComponent(wellFormed(text))
    .replace(/%20/g, '+')
    .replace(
      /[!'()~]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

/** The entries as `application/x-www-form-urlencoded`: a query string, and
 *  a POST body of that type. */
export function urlencoded(entries: readonly [string, string][]): string {
  return entries
    .map(
      ([name, value]) => `${formEncode(crlf(name))}=${formEncode(crlf(value))}`,
    )
    .join('&');
}

/** The entries as `text/plain`: a line each, `name=value`, unescaped. */
export function plainText(entries: readonly [string, string][]): string {
  return entries
    .map(([name, value]) => `${crlf(name)}=${crlf(value)}\r\n`)
    .join('');
}

/** A name in a `Content-Disposition` header: its quote and its line breaks
 *  percent-encoded, as browsers write them (HTML 4.10.21.8). */
function dispositionName(name: string): string {
  return crlf(name).replace(/[\r\n"]/g, (c) =>
    c === '"' ? '%22' : c === '\r' ? '%0D' : '%0A',
  );
}

function multipart(entries: readonly Entry[], boundary: string): string {
  let body = '';
  for (const { name, value, file } of entries) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${dispositionName(name)}"`;
    body += file
      ? `; filename="${dispositionName(value)}"\r\nContent-Type: application/octet-stream\r\n\r\n\r\n`
      : `\r\n\r\n${crlf(value)}\r\n`;
  }
  return `${body}--${boundary}--\r\n`;
}

function makeBoundary(): string {
  let tail = '';
  while (tail.length < 24) tail += Math.random().toString(36).slice(2);
  return `----react-x11-form-${tail.slice(0, 24)}`;
}

/** `url` with its query replaced by `query` and its fragment kept — HTML's
 *  "mutate action URL". A GET always carries a query, if an empty one. */
function withQuery(url: string, query: string): string {
  const hash = url.indexOf('#');
  const fragment = hash < 0 ? '' : url.slice(hash);
  const head = hash < 0 ? url : url.slice(0, hash);
  const q = head.indexOf('?');
  return `${q < 0 ? head : head.slice(0, q)}?${query}${fragment}`;
}

// --- a submission -----------------------------------------------------------------

function enctypeOf(raw: string | undefined): FormEnctype {
  const type = (raw ?? '').trim().toLowerCase();
  return type === 'multipart/form-data' || type === 'text/plain'
    ? type
    : 'application/x-www-form-urlencoded';
}

/** The first `<base target>` in the document, or empty. */
function baseTarget(root: AnyNode): string {
  for (const el of elementsIn(root)) {
    if (tagOf(el) === 'base' && attr(el, 'target') !== undefined) {
      return attr(el, 'target') ?? '';
    }
  }
  return '';
}

/**
 * A form's submission by `submitter` (HTML 4.10.21.3): its entries, and the
 * request they make. The button's `formaction`, `formmethod`, `formenctype`
 * and `formtarget` win over the form's own. Null for `method="dialog"`,
 * which closes a dialog rather than submitting anything, and for a
 * submitter the form does not own.
 */
export function formSubmission(
  form: Element,
  submitter: Element | null,
  context: SubmitContext,
): FormSubmission | null {
  if (submitter && formOwner(submitter) !== form) return null;
  const pick = (own: string, formName: string): string | undefined =>
    (submitter ? attr(submitter, own) : undefined) ?? attr(form, formName);
  const methodName = (pick('formmethod', 'method') ?? '').trim().toLowerCase();
  if (methodName === 'dialog') return null;
  const method: FormMethod = methodName === 'post' ? 'post' : 'get';

  const written = pick('formaction', 'action') ?? '';
  const documentUrl = context.documentUrl ?? context.base ?? '';
  const action = written.trim()
    ? resolveUrl(written, context.base)
    : documentUrl;
  const enctype = enctypeOf(pick('formenctype', 'enctype'));
  const target = pick('formtarget', 'target') ?? baseTarget(rootOf(form));

  const list = entriesOf(form, submitter, context.live, context.point);
  const entries = list.map(({ name, value }): [string, string] => [
    name,
    value,
  ]);
  const base = { form, submitter, enctype, entries, target };
  if (method === 'get') {
    // a `mailto:` form writes its entries as headers, which spell a space
    // `%20` (HTML 4.10.21.3, "mail with headers")
    const query = /^mailto:/i.test(action)
      ? urlencoded(entries).replace(/\+/g, '%20')
      : urlencoded(entries);
    return {
      ...base,
      method,
      url: withQuery(action, query),
      body: null,
      contentType: null,
    };
  }
  if (enctype === 'multipart/form-data') {
    const boundary = context.boundary ?? makeBoundary();
    return {
      ...base,
      method,
      url: action,
      body: multipart(list, boundary),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }
  return {
    ...base,
    method,
    url: action,
    body: enctype === 'text/plain' ? plainText(entries) : urlencoded(entries),
    contentType:
      enctype === 'text/plain' ? 'text/plain;charset=UTF-8' : enctype,
  };
}

/**
 * What Enter in a field submits (HTML 4.10.21.2, "implicit submission"): its
 * form, by the form's default button — the first submit button it owns —
 * or, where it has none, by no button at all, so long as the form has at
 * most one field of the kinds that would make Enter ambiguous. Null where
 * Enter submits nothing: no form, a disabled default button, or a form of
 * several fields and no button.
 */
export function implicitSubmission(
  field: Element,
): { form: Element; submitter: Element | null } | null {
  const form = formOwner(field);
  if (!form) return null;
  let fields = 0;
  for (const el of controlsOf(form)) {
    if (buttonType(el) === 'submit') {
      return isDisabled(el) ? null : { form, submitter: el };
    }
    if (tagOf(el) === 'input' && BLOCKS_IMPLICIT.has(inputType(el))) {
      fields += 1;
    }
  }
  return fields > 1 ? null : { form, submitter: null };
}

// --- the live state ----------------------------------------------------------------

/** What a control's attributes were before anything was typed or chosen. */
interface Snapshot {
  attribs: Record<string, string | undefined>;
  /** For a `<select>`: which of its options were `selected`. */
  selected?: Element[];
}

/**
 * What a document's controls hold that its markup does not, and what their
 * markup said before. One per `<Html>`, keyed by element, so a re-parse —
 * new elements — starts clean.
 *
 * Typed text lives here rather than in the DOM because HTML's `value`
 * attribute is the field's *default*: it is what a reset puts back, and
 * what a `<textarea>` has is its content, which is not an attribute at all.
 * A checkbox, a radio and a `<select>` do keep what they hold in the DOM —
 * `checked` and `selected` — because `:checked` is a selector documents
 * really use and it reads those; so for them this keeps the markup's
 * attributes, from before the first change, for a reset.
 */
export class FormState {
  private _typed = new WeakMap<Element, string>();
  private _markup = new WeakMap<Element, Snapshot>();

  /** Typed text, where the field has any — the `live` a submission reads. */
  typed(el: Element): string | undefined {
    return this._typed.get(el);
  }

  /** What a text control holds now: typed, or its markup's. */
  value(el: Element): string {
    return controlValue(el, (e) => this._typed.get(e));
  }

  setTyped(el: Element, text: string): void {
    this.remember(el);
    this._typed.set(el, text);
  }

  /** Keep what `el`'s markup says, before a change to its attributes. */
  remember(el: Element): void {
    if (this._markup.has(el)) return;
    const tag = tagOf(el);
    const snapshot: Snapshot = {
      attribs: {
        checked: attr(el, 'checked'),
        value: attr(el, 'value'),
      },
    };
    if (tag === 'select') {
      snapshot.selected = optionElements(el).filter(
        (o) => attr(o, 'selected') !== undefined,
      );
    }
    this._markup.set(el, snapshot);
  }

  /**
   * Put every control `form` owns back as its markup had it (HTML 4.10.21.5,
   * "reset"). True when anything changed — the widgets then mount again, to
   * show it.
   */
  reset(form: Element): boolean {
    let changed = false;
    for (const el of controlsOf(form)) {
      changed = this._typed.delete(el) || changed;
      const snapshot = this._markup.get(el);
      if (!snapshot) continue;
      this._markup.delete(el);
      changed = true;
      for (const [name, value] of Object.entries(snapshot.attribs)) {
        if (value === undefined) delete el.attribs[name];
        else el.attribs[name] = value;
      }
      if (snapshot.selected) {
        for (const option of optionElements(el)) {
          if (snapshot.selected.includes(option)) option.attribs.selected = '';
          else delete option.attribs.selected;
        }
      }
    }
    return changed;
  }
}

/**
 * The other radios in `radio`'s group (HTML 4.10.5.1.18): the inputs of type
 * radio with the same name, in the same form — or, for one in no form, in
 * no form either. Checking one unchecks these.
 */
export function radioGroup(radio: Element): Element[] {
  const name = attr(radio, 'name');
  if (!name) return [];
  const root = rootOf(radio);
  const form = formOwner(radio, root);
  const out: Element[] = [];
  const candidates = form ? controlsOf(form) : elementsIn(root);
  for (const el of candidates) {
    if (
      el !== radio &&
      tagOf(el) === 'input' &&
      inputType(el) === 'radio' &&
      attr(el, 'name') === name &&
      (form || formOwner(el, root) === null)
    ) {
      out.push(el);
    }
  }
  return out;
}
