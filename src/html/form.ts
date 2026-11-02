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

import {
  NON_RENDERED,
  attr,
  childrenOf,
  elementsIn,
  isElement,
  isForeign,
  parsedForm,
  tagOf,
  treeGeneration,
} from './dom.js';
import type { HtmlChange } from './dom.js';
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

/** Whether an element is one: an `<input>` a drawing or a `<math>` holds is
 *  only a name, which no form owns. */
function isSubmittable(el: Element): boolean {
  return SUBMITTABLE.has(tagOf(el)) && !isForeign(el);
}

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
 * attribute names by id, or else the nearest `<form>` around it, or else the
 * one the parser met last, which a `<table><form>` needs: the form closes as
 * it opens, and the rows after it are none of its. A `form` attribute that
 * names nothing, or names something that is not a form, leaves it with none —
 * it does not fall back to the form around it.
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
  const parsed = parsedForm(el);
  return parsed && rootOf(parsed) === root ? parsed : null;
}

/** The first element in the document with an id, as `getElementById`
 *  finds it: never one inside a `<template>`, whose content is no part of
 *  the document. */
function elementById(root: AnyNode, id: string): Element | null {
  for (const el of elementsIn(root, NON_RENDERED)) {
    if (attr(el, 'id') === id) return el;
  }
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
  for (const el of elementsIn(root, NON_RENDERED)) {
    if (!isSubmittable(el)) continue;
    // one walk for every id, and only when something asks by one
    if (attr(el, 'form') !== undefined && !byId) {
      byId = new Map();
      for (const any of elementsIn(root, NON_RENDERED)) {
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

/** A `<textarea>`'s text as its markup has it, which the parser took the
 *  newline straight after its open tag off. */
export function textareaDefault(el: Element): string {
  let text = '';
  for (const child of childrenOf(el)) {
    if (child.type === 'text') text += child.data;
  }
  return text;
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
    case 'date':
    case 'month':
    case 'week':
    case 'time':
    case 'datetime-local':
      return fieldNumber(inputType(el), raw) === null ? '' : raw;
    default:
      return raw;
  }
}

/** The `<input>` types whose value is a place on a line, which `min`, `max`
 *  and `step` apply to: the step each takes with none said, and how many of
 *  the numbers `fieldNumber` reads make a unit of one (HTML 4.10.5.1). */
const STEPS: Record<string, readonly [step: number, unit: number]> = {
  number: [1, 1],
  range: [1, 1],
  date: [1, 86400000],
  month: [1, 1],
  week: [1, 604800000],
  time: [60, 1000],
  'datetime-local': [60, 1000],
};

/** What a week's step counts from with no `min` and no `value`: 1970-W01's
 *  Monday, in milliseconds (HTML 4.10.5.1.10). */
const WEEK_BASE = -259200000;

/** A day as milliseconds since the epoch, or null for none the calendar
 *  has. */
function dayNumber(year: number, month: number, day: number): number | null {
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCMonth() === month - 1 ? date.getTime() : null;
}

/** A week's Monday as milliseconds since the epoch (ISO 8601), or null for
 *  one its year does not have. */
function weekNumber(year: number, week: number): number | null {
  const monday = (y: number): number => {
    const fourth = dayNumber(y, 1, 4)!;
    return fourth - ((new Date(fourth).getUTCDay() + 6) % 7) * 86400000;
  };
  if (year < 1 || week < 1) return null;
  const first = monday(year);
  if (week > Math.round((monday(year + 1) - first) / 604800000)) return null;
  return first + (week - 1) * 604800000;
}

/** A time of day as milliseconds, or null for none. */
function timeNumber(text: string): number | null {
  const m = /^(\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?$/.exec(text);
  if (!m) return null;
  const [hour, minute, second] = [m[1], m[2], m[3] ?? '0'].map(Number);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const ms = Number((m[4] ?? '').padEnd(3, '0'));
  return (hour * 3600 + minute * 60 + second) * 1000 + ms;
}

/**
 * What a field of a type in `STEPS` holds as a number to compare and step
 * by, or null where the text is no valid value of the type (HTML 2.3.5):
 * milliseconds for a date, a week and a time, months for a month.
 */
function fieldNumber(type: string, text: string): number | null {
  if (type === 'number' || type === 'range') {
    const n = FLOAT.test(text) ? Number(text) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'time') return timeNumber(text);
  if (type === 'datetime-local') {
    const m = /^(\d{4,})-(\d\d)-(\d\d)[T ](.+)$/.exec(text);
    const day = m && dayNumber(Number(m[1]), Number(m[2]), Number(m[3]));
    const time = m && timeNumber(m[4]);
    return day === null || time === null ? null : day + time;
  }
  if (type === 'date') {
    const m = /^(\d{4,})-(\d\d)-(\d\d)$/.exec(text);
    return m && dayNumber(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  if (type === 'month') {
    const m = /^(\d{4,})-(\d\d)$/.exec(text);
    const month = m ? Number(m[2]) : 0;
    if (!m || Number(m[1]) < 1 || month < 1 || month > 12) return null;
    return (Number(m[1]) - 1970) * 12 + month - 1;
  }
  if (type === 'week') {
    const m = /^(\d{4,})-W(\d\d)$/.exec(text);
    return m && weekNumber(Number(m[1]), Number(m[2]));
  }
  return null;
}

/** A limit or a base of a field, as `fieldNumber` reads it. */
function attributeNumber(
  el: Element,
  name: string,
  type: string,
): number | null {
  const text = attr(el, name);
  return text === undefined ? null : fieldNumber(type, text.trim());
}

/** Where a field's value stands against its `min` and its `max`: below
 *  them, above them or between, and null with neither. A `time` whose `min`
 *  is later than its `max` runs past midnight (HTML 4.10.5.1.10). */
function rangePlace(
  el: Element,
  type: string,
  value: number,
): 'under' | 'over' | 'inside' | null {
  const min = attributeNumber(el, 'min', type);
  const max = attributeNumber(el, 'max', type);
  if (min === null && max === null) return null;
  if (type === 'time' && min !== null && max !== null && min > max) {
    return value >= min || value <= max ? 'inside' : 'over';
  }
  if (min !== null && value < min) return 'under';
  if (max !== null && value > max) return 'over';
  return 'inside';
}

/** Whether a field's value is off its steps (HTML 4.10.5.1.13), each step
 *  counted from its `min`, or its `value` attribute, or the type's base,
 *  with Blink's room for a double's error. */
function offStep(el: Element, type: string, value: number): boolean {
  const written = attr(el, 'step')?.trim();
  if (written?.toLowerCase() === 'any') return false;
  const [step, unit] = STEPS[type];
  const asked = written && FLOAT.test(written) ? Number(written) : 0;
  const size = (asked > 0 ? asked : step) * unit;
  const base =
    attributeNumber(el, 'min', type) ??
    attributeNumber(el, 'value', type) ??
    (type === 'week' ? WEEK_BASE : 0);
  const off = Math.abs(value - base);
  if (off > 1e15) return false;
  const rest = Math.abs(off - size * Math.round(off / size));
  const room = size / 2 ** 24;
  return room < rest && rest < size - room;
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
  for (const el of elementsIn(root, NON_RENDERED)) {
    if (
      tagOf(el) === 'base' &&
      !isForeign(el) &&
      attr(el, 'target') !== undefined
    ) {
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

// --- labels ------------------------------------------------------------------------

/** Whether an element can be what a `<label>` labels (HTML 4.10.2). */
function labelable(el: Element): boolean {
  const tag = tagOf(el);
  if (tag === 'input') return inputType(el) !== 'hidden';
  return (
    tag === 'button' ||
    tag === 'select' ||
    tag === 'textarea' ||
    tag === 'meter' ||
    tag === 'output' ||
    tag === 'progress'
  );
}

/**
 * The control a `<label>` is for (HTML 4.10.4): the one its `for` names by
 * id, where that is one a label can label, or else the first such control
 * inside it. A press on the label is a press on that control.
 */
export function labeledControl(label: Element): Element | null {
  const id = attr(label, 'for');
  if (id !== undefined) {
    const named = elementById(rootOf(label), id);
    return named && labelable(named) ? named : null;
  }
  for (const el of elementsIn(label, NON_RENDERED)) {
    if (labelable(el)) return el;
  }
  return null;
}

// --- constraint validation ----------------------------------------------------------

/** HTML's valid email address (4.10.5.1.5), as the spec writes it. */
const EMAIL =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** The kinds of field `pattern`, `minlength` and `maxlength` apply to. */
const TEXTUAL = new Set(['text', 'search', 'url', 'tel', 'email', 'password']);

interface UrlCtor {
  new (url: string): unknown;
}

function absoluteUrl(text: string): boolean {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return false;
  const URLClass = (globalThis as { URL?: UrlCtor }).URL;
  if (!URLClass) return true;
  try {
    new URLClass(text);
    return true;
  } catch {
    return false;
  }
}

/** A `pattern` as HTML compiles it: the whole value, in `v` mode — or `u`
 *  where the runtime has no `v` — and no constraint at all where it does
 *  not compile. */
function patternOf(source: string): RegExp | null {
  for (const flags of ['v', 'u']) {
    try {
      return new RegExp(`^(?:${source})$`, flags);
    } catch {
      // try the next, then give up
    }
  }
  return null;
}

/** Whether a control's value is checked at all (HTML 4.10.21.2, "barred
 *  from constraint validation"), which `willValidate` reads. As Blink has
 *  it: an image button is not, where HTML's table says it is, and a
 *  `readonly` bars every `<input>`, which a type it does not apply to the
 *  rest of HTML ignores. */
export function validated(el: Element): boolean {
  const tag = tagOf(el);
  if (tag === 'input') {
    const type = inputType(el);
    if (
      type === 'hidden' ||
      type === 'reset' ||
      type === 'button' ||
      type === 'image' ||
      attr(el, 'readonly') !== undefined
    ) {
      return false;
    }
  } else if (tag === 'textarea') {
    if (attr(el, 'readonly') !== undefined) return false;
  } else if (tag === 'button') {
    if (buttonType(el) !== 'submit') return false;
  } else if (tag !== 'select' && !FORM_ASSOCIATED.has(el)) return false;
  return !isDisabled(el) && !inert(el);
}

/** The ways a control can be wrong: `ValidityState`'s members. */
export type ValidityFlag =
  | 'valueMissing'
  | 'typeMismatch'
  | 'patternMismatch'
  | 'tooLong'
  | 'tooShort'
  | 'rangeUnderflow'
  | 'rangeOverflow'
  | 'stepMismatch'
  | 'badInput'
  | 'customError';

/** What is wrong with a control, and how a browser says it. */
export interface ValidityError {
  flag: ValidityFlag;
  message: string;
}

/**
 * What is wrong with a control's value, or null where nothing is: a
 * script's own words (`setCustomValidity()`) and then the constraints a
 * document can state — `required`, `minlength` and `maxlength`, `pattern`,
 * `min`, `max` and `step`, and an email, a URL or a number that is not one
 * (HTML 4.10.20). A length is checked only of what the user typed, as HTML
 * checks it: a document's own value and a script's are the author's to get
 * right. `live` is what a text control holds where its markup does not say,
 * as `FormState` has it.
 */
export function validityError(
  el: Element,
  live: (el: Element) => string | undefined = typedText,
): ValidityError | null {
  if (!validated(el)) return null;
  const custom = CUSTOM_ERRORS.get(el);
  if (custom) return { flag: 'customError', message: custom };
  const tag = tagOf(el);
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return null;
  const wrong = (flag: ValidityFlag, message: string): ValidityError => ({
    flag,
    message,
  });
  const required = attr(el, 'required') !== undefined;
  if (tag === 'select') {
    if (!required) return null;
    const selected = selectedOptions(el);
    const placeholder =
      !isMultiple(el) &&
      selected.length === 1 &&
      selected[0] === optionElements(el)[0] &&
      selected[0].parent === el &&
      optionValue(selected[0]) === '';
    return !selected.length || placeholder
      ? wrong('valueMissing', 'Please select an item in the list.')
      : null;
  }
  const type = tag === 'input' ? inputType(el) : 'textarea';
  if (type === 'checkbox') {
    return required && attr(el, 'checked') === undefined
      ? wrong('valueMissing', 'Please check this box if you want to proceed.')
      : null;
  }
  if (type === 'radio') {
    const group = [el, ...radioGroup(el)];
    if (!group.some((r) => attr(r, 'required') !== undefined)) return null;
    return group.some((r) => attr(r, 'checked') !== undefined)
      ? null
      : wrong('valueMissing', 'Please select one of these options.');
  }
  if (type === 'file') {
    return required ? wrong('valueMissing', 'Please select a file.') : null;
  }
  if (type === 'range' || type === 'color' || type === 'submit') return null;

  const typed = live(el);
  const value = controlValue(el, live);
  if (type === 'number' && typed !== undefined && typed.trim() && !value) {
    return wrong('badInput', 'Please enter a number.');
  }
  if (!value) {
    return required
      ? wrong('valueMissing', 'Please fill out this field.')
      : null;
  }

  if (
    typed !== undefined &&
    !SET_BY_SCRIPT.has(el) &&
    (type === 'textarea' || TEXTUAL.has(type))
  ) {
    const length = value.length;
    const min = Number(attr(el, 'minlength'));
    if (min > 0 && length < min) {
      return wrong(
        'tooShort',
        `Please lengthen this text to ${min} characters or more (you are currently using ${length} characters).`,
      );
    }
    const max = attr(el, 'maxlength');
    if (max !== undefined && /^\d+$/.test(max.trim()) && length > Number(max)) {
      return wrong(
        'tooLong',
        `Please shorten this text to ${Number(max)} characters or less (you are currently using ${length} characters).`,
      );
    }
  }
  if (type === 'email') {
    const addresses =
      attr(el, 'multiple') !== undefined
        ? value.split(',').map((a) => a.trim())
        : [value];
    if (!addresses.every((a) => EMAIL.test(a))) {
      return wrong('typeMismatch', 'Please enter an email address.');
    }
  }
  if (type === 'url' && !absoluteUrl(value)) {
    return wrong('typeMismatch', 'Please enter a URL.');
  }
  const pattern = attr(el, 'pattern');
  if (pattern !== undefined && TEXTUAL.has(type)) {
    const re = patternOf(pattern);
    const values =
      type === 'email' && attr(el, 'multiple') !== undefined
        ? value.split(',').map((a) => a.trim())
        : [value];
    if (re && !values.every((v) => re.test(v))) {
      const title = attr(el, 'title');
      return wrong(
        'patternMismatch',
        title
          ? `Please match the requested format:\n${title}`
          : 'Please match the requested format.',
      );
    }
  }
  const stepped = STEPS[type] ? fieldNumber(type, value) : null;
  if (stepped === null) return null;
  const place = rangePlace(el, type, stepped);
  const number = type === 'number';
  if (place === 'under') {
    const min = attr(el, 'min')?.trim();
    return wrong(
      'rangeUnderflow',
      number
        ? `Value must be greater than or equal to ${min}.`
        : `Value must be ${min} or later.`,
    );
  }
  if (place === 'over') {
    const max = attr(el, 'max')?.trim();
    return wrong(
      'rangeOverflow',
      number
        ? `Value must be less than or equal to ${max}.`
        : `Value must be ${max} or earlier.`,
    );
  }
  return offStep(el, type, stepped)
    ? wrong('stepMismatch', 'Please enter a valid value.')
    : null;
}

/** `validityError`'s words alone. */
export function validationMessage(
  el: Element,
  live?: (el: Element) => string | undefined,
): string | null {
  return validityError(el, live)?.message ?? null;
}

/**
 * The first control a submission would be refused over, and why — HTML's
 * interactive validation (4.10.21.3), which a form's `novalidate` or its
 * submitter's `formnovalidate` turns off. Null where the form may go.
 */
export function firstInvalid(
  form: Element,
  submitter: Element | null,
  live?: (el: Element) => string | undefined,
): { element: Element; message: string } | null {
  if (attr(form, 'novalidate') !== undefined) return null;
  if (submitter && attr(submitter, 'formnovalidate') !== undefined) {
    return null;
  }
  for (const el of controlsOf(form)) {
    const message = validationMessage(el, live);
    if (message) return { element: el, message };
  }
  return null;
}

// --- the live state ----------------------------------------------------------------

/**
 * A text control's selection as HTML's `selectionStart`, `selectionEnd` and
 * `selectionDirection` read it (4.10.5.2.10): offsets into what the control
 * holds, in UTF-16 code units, the start never past the end, and the end
 * the caret's where the direction is not `'backward'`.
 */
export interface FieldSelection {
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
}

/** What a control's attributes were before anything was typed or chosen. */
interface Snapshot {
  attribs: Record<string, string | undefined>;
  /** For a `<select>`: which of its options were `selected`. */
  selected?: Element[];
}

/** What each control holds that its markup does not, and what its markup
 *  said before: by element and no `<Html>`'s, since the cascade and a page's
 *  query read them too, through a selector, and have no `FormState`. */
const TYPED = new WeakMap<Element, string>();
const MARKUP = new WeakMap<Element, Snapshot>();

/** The fields a script's `value` set last, which a length is not held to
 *  (HTML 4.10.5.1.3, "last changed by a user edit"). */
const SET_BY_SCRIPT = new WeakSet<Element>();

/** What `setCustomValidity()` set, or `ElementInternals.setValidity()`. */
const CUSTOM_ERRORS = new WeakMap<Element, string>();

/** Custom elements that take part in forms, which validation reads as it
 *  does a control. */
const FORM_ASSOCIATED = new WeakSet<Element>();

/** The boxes a script set `indeterminate` on. */
const INDETERMINATE = new WeakSet<Element>();

/** The controls whose validity the user is to see (HTML 4.10.18.5, "user
 *  validity"): `:user-valid` and `:user-invalid` read it. */
const USER_VALIDITY = new WeakSet<Element>();

/** What a text control holds where its markup does not say. */
export function typedText(el: Element): string | undefined {
  return TYPED.get(el);
}

/** A script's reason a control is wrong, '' for none: whether it changed. */
export function setCustomError(el: Element, message: string): boolean {
  if ((CUSTOM_ERRORS.get(el) ?? '') === message) return false;
  if (message) CUSTOM_ERRORS.set(el, message);
  else CUSTOM_ERRORS.delete(el);
  return true;
}

/** A custom element a definition says takes part in forms. */
export function markFormAssociated(el: Element): void {
  FORM_ASSOCIATED.add(el);
}

/** A control's `indeterminate` IDL attribute: whether it changed. */
export function setIndeterminate(el: Element, on: boolean): boolean {
  if (INDETERMINATE.has(el) === on) return false;
  if (on) INDETERMINATE.add(el);
  else INDETERMINATE.delete(el);
  return true;
}

/** What a script last set a control's `indeterminate` to. */
export function indeterminateSet(el: Element): boolean {
  return INDETERMINATE.has(el);
}

/** A control's user validity: whether it changed. */
export function setUserValidity(el: Element, on: boolean): boolean {
  if (USER_VALIDITY.has(el) === on) return false;
  if (on) USER_VALIDITY.add(el);
  else USER_VALIDITY.delete(el);
  return true;
}

/** Whether a control's validity is the user's to see. */
export function hasUserValidity(el: Element): boolean {
  return USER_VALIDITY.has(el);
}

/** What a checkbox's or a radio's markup says of `checked` once its
 *  attribute holds what it is now (`FormState`): null for nothing, and
 *  undefined for one nothing has ticked. */
export function checkedDefault(el: Element): string | null | undefined {
  const kept = MARKUP.get(el);
  return kept && (kept.attribs.checked ?? null);
}

/** That default, as a script set it. */
export function setCheckedDefault(el: Element, value: string | null): void {
  const kept = MARKUP.get(el);
  if (kept) kept.attribs.checked = value ?? undefined;
}

/**
 * What a document's controls hold that its markup does not, and what their
 * markup said before: one per `<Html>`, over state keyed by element, so a
 * re-parse — new elements — starts clean.
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
  private _selections = new WeakMap<Element, FieldSelection>();
  /** The fields the user typed in since they took the focus, which their
   *  leaving it shows the validity of. */
  private _edited = new WeakSet<Element>();

  /** Typed text, where the field has any — the `live` a submission reads. */
  typed(el: Element): string | undefined {
    return TYPED.get(el);
  }

  /** What a text control holds now: typed, or its markup's. */
  value(el: Element): string {
    return controlValue(el, typedText);
  }

  /** What a text field holds now, the user's unless a script set it. */
  setTyped(el: Element, text: string, script = false): void {
    this.remember(el);
    TYPED.set(el, text);
    if (script) SET_BY_SCRIPT.add(el);
    else {
      SET_BY_SCRIPT.delete(el);
      this._edited.add(el);
    }
  }

  /** Whether the user typed in a field since this was last asked. */
  takeEdited(el: Element): boolean {
    return this._edited.delete(el);
  }

  /**
   * A text field's selection where no widget holds it: what a script set
   * before the field's widget was mounted, or what the widget had as it
   * went — kept to what the field holds now. Null where nothing was kept,
   * which a widget mounts as a caret at the end of its text.
   */
  selection(el: Element): FieldSelection | null {
    const kept = this._selections.get(el);
    if (!kept) return null;
    const length = this.value(el).length;
    const end = Math.min(kept.end, length);
    return {
      start: Math.min(kept.start, end),
      end,
      direction: kept.direction,
    };
  }

  /** Keep a field's selection for its widget's next mount; null forgets it,
   *  which leaves the caret at the end of the field's text. */
  keepSelection(el: Element, selection: FieldSelection | null): void {
    if (selection) this._selections.set(el, { ...selection });
    else this._selections.delete(el);
  }

  /** Keep what `el`'s markup says, before a change to its attributes. */
  remember(el: Element): void {
    if (MARKUP.has(el)) return;
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
    MARKUP.set(el, snapshot);
  }

  /**
   * Put every control `form` owns back as its markup had it (HTML 4.10.21.5,
   * "reset"). True when anything changed — a mounted field's text is then
   * the caller's to set, since its widget holds it, and the rest follow
   * their attributes.
   */
  reset(form: Element): boolean {
    let changed = false;
    for (const el of controlsOf(form)) {
      changed = TYPED.delete(el) || changed;
      changed = setUserValidity(el, false) || changed;
      SET_BY_SCRIPT.delete(el);
      this._edited.delete(el);
      const snapshot = MARKUP.get(el);
      if (!snapshot) continue;
      MARKUP.delete(el);
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
  const candidates = form ? controlsOf(form) : elementsIn(root, NON_RENDERED);
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

// --- what a selector asks of a control --------------------------------------------

/** The `<input>` types with a placeholder to show, and those a `readonly`
 *  applies to (HTML 4.10.5, the table of what applies to which). */
const TAKES_PLACEHOLDER = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
]);
const TAKES_READONLY = new Set([
  ...TAKES_PLACEHOLDER,
  'date',
  'month',
  'week',
  'time',
  'datetime-local',
]);

/** The elements in a tree that own or are owned, for what one control's
 *  answer reads of the others. */
interface ControlIndex {
  generation: number;
  told: number;
  /** Each form's controls, and those of no form under null, in tree order. */
  owned: Map<Element | null, Element[]>;
  forms: Element[];
}
const CONTROL_INDEXES = new WeakMap<AnyNode, ControlIndex>();

/** Bumped by a change `treeGeneration` hears of only at the next flush: a
 *  page's script reads a selector straight after it changed the tree. */
let controlsTold = 0;

/** A page's script changed a tree. */
export function controlsMoved(): void {
  controlsTold += 1;
}

/** The controls in a tree by their form, walked once a tree: a page with a
 *  rule on `:indeterminate` asks of every radio, and each asking `controlsOf`
 *  walks the document. */
function controlIndex(root: AnyNode): ControlIndex {
  const generation = treeGeneration();
  const kept = CONTROL_INDEXES.get(root);
  if (kept?.generation === generation && kept.told === controlsTold) {
    return kept;
  }
  const owned = new Map<Element | null, Element[]>();
  const forms: Element[] = [];
  const index = { generation, told: controlsTold, owned, forms };
  let byId: Map<string, Element> | null = null;
  for (const el of elementsIn(root, NON_RENDERED)) {
    if (tagOf(el) === 'form') forms.push(el);
    if (!isSubmittable(el) && !FORM_ASSOCIATED.has(el)) continue;
    if (inert(el)) continue;
    if (attr(el, 'form') !== undefined && !byId) {
      byId = new Map();
      for (const any of elementsIn(root, NON_RENDERED)) {
        const id = attr(any, 'id');
        if (id !== undefined && !byId.has(id)) byId.set(id, any);
      }
    }
    const owner = ownerOf(el, root, byId);
    const list = owned.get(owner);
    if (list) list.push(el);
    else owned.set(owner, [el]);
  }
  CONTROL_INDEXES.set(root, index);
  return index;
}

/** Whether a form or a fieldset holds a control that is wrong: a form by
 *  what it owns, wherever that is, and a fieldset by what is in it, a
 *  disabled one's first legend's included, and `novalidate` changes neither
 *  (HTML 4.16.3, `:valid`, `:invalid`). */
function holdsInvalid(el: Element): boolean {
  if (tagOf(el) === 'form') {
    const owned = controlIndex(rootOf(el)).owned.get(el);
    return !!owned?.some((control) => validityError(control));
  }
  for (const inside of elementsIn(el, NON_RENDERED)) {
    if (validityError(inside)) return true;
  }
  return false;
}

/** What `:valid` answers, and `:invalid` the opposite: null where neither
 *  matches, an element no form reads. */
function validityAnswer(el: Element): boolean | null {
  const tag = tagOf(el);
  if (tag === 'form' || tag === 'fieldset') return !holdsInvalid(el);
  return validated(el) ? validityError(el) === null : null;
}

export function isValid(el: Element): boolean {
  return validityAnswer(el) === true;
}

export function isInvalid(el: Element): boolean {
  return validityAnswer(el) === false;
}

/** `:user-valid` and `:user-invalid`: validity once the user is to see it. */
export function isUserValid(el: Element): boolean {
  return USER_VALIDITY.has(el) && validated(el) && !validityError(el);
}

export function isUserInvalid(el: Element): boolean {
  return USER_VALIDITY.has(el) && !!validityError(el);
}

/**
 * What `:in-range` answers and `:out-of-range` the opposite, null where
 * neither matches. Blink's: an empty field of a type with a place on a line
 * is in range whether or not it has limits, where Selectors 4 asks for
 * limits and Gecko and WebKit have them, and a slider, whose value its
 * sanitization keeps between them, is in range whatever they say.
 */
function rangeAnswer(el: Element): boolean | null {
  if (tagOf(el) !== 'input') return null;
  const type = inputType(el);
  if (!STEPS[type] || !validated(el)) return null;
  if (type === 'range') return true;
  const value = fieldNumber(type, controlValue(el, typedText));
  if (value === null) return true;
  const place = rangePlace(el, type, value);
  return place === null ? null : place === 'inside';
}

export function isInRange(el: Element): boolean {
  return rangeAnswer(el) === true;
}

export function isOutOfRange(el: Element): boolean {
  return rangeAnswer(el) === false;
}

/** `:placeholder-shown`: a field that takes a `placeholder`, with one,
 *  however empty, and nothing in it. A number field holding what is no
 *  number shows it as typed. */
export function placeholderShown(el: Element): boolean {
  const tag = tagOf(el);
  if (tag !== 'textarea') {
    if (tag !== 'input' || !TAKES_PLACEHOLDER.has(inputType(el))) return false;
  }
  if (attr(el, 'placeholder') === undefined) return false;
  return !(TYPED.get(el) ?? controlValue(el));
}

/** Whether an element is an editing host or inside one: the nearest
 *  `contenteditable` that says. */
function editable(el: Element): boolean {
  for (let at: AnyNode | null = el; at && isElement(at); at = at.parent) {
    const value = attr(at, 'contenteditable')?.toLowerCase();
    if (value === '' || value === 'true' || value === 'plaintext-only') {
      return true;
    }
    if (value === 'false') return false;
  }
  return false;
}

/** `:read-write`: a field a user can type in, or what is editable. A
 *  control is its own affair inside an editing host. */
export function isReadWrite(el: Element): boolean {
  const tag = tagOf(el);
  if (
    tag === 'textarea' ||
    (tag === 'input' && TAKES_READONLY.has(inputType(el)))
  ) {
    return attr(el, 'readonly') === undefined && !isDisabled(el);
  }
  return tag !== 'input' && editable(el);
}

/** `:read-only`: every other HTML element, and as Blink has it no SVG's,
 *  which Gecko and WebKit match. */
export function isReadOnly(el: Element): boolean {
  if (isReadWrite(el)) return false;
  for (let at: AnyNode | null = el; at && isElement(at); at = at.parent) {
    const tag = tagOf(at);
    if (tag === 'svg') return false;
    if (tag === 'foreignobject') break;
  }
  return true;
}

/** Whether another radio of `radio`'s group is checked, or it is: its form's
 *  of the name, or of no form the tree's. One with no name is alone. */
function groupChecked(radio: Element): boolean {
  if (attr(radio, 'checked') !== undefined) return true;
  const name = attr(radio, 'name');
  if (!name) return false;
  const root = rootOf(radio);
  const list = controlIndex(root).owned.get(formOwner(radio, root));
  return !!list?.some(
    (el) =>
      tagOf(el) === 'input' &&
      inputType(el) === 'radio' &&
      attr(el, 'name') === name &&
      attr(el, 'checked') !== undefined,
  );
}

/** `:indeterminate`: a box a script said is, a radio with nothing checked in
 *  its group, and a `<progress>` with no `value`, whatever that says. */
export function isIndeterminate(el: Element): boolean {
  const tag = tagOf(el);
  if (tag === 'progress') return attr(el, 'value') === undefined;
  if (tag !== 'input') return false;
  const type = inputType(el);
  if (type === 'checkbox') return INDETERMINATE.has(el);
  return type === 'radio' && !groupChecked(el);
}

/**
 * `:default`: a box or a radio its markup checks, whatever it is now; an
 * option its markup selects; and a form's first submit button, disabled or
 * not (HTML 4.16.3).
 */
export function isDefault(el: Element): boolean {
  const tag = tagOf(el);
  if (tag === 'option') {
    let select: AnyNode | null = el.parent;
    if (select && isElement(select) && tagOf(select) === 'optgroup') {
      select = select.parent;
    }
    const kept =
      select && isElement(select) ? MARKUP.get(select)?.selected : undefined;
    return kept ? kept.includes(el) : attr(el, 'selected') !== undefined;
  }
  if (tag === 'input') {
    const type = inputType(el);
    if (type === 'checkbox' || type === 'radio') {
      const kept = MARKUP.get(el);
      const checked = kept ? kept.attribs.checked : attr(el, 'checked');
      return checked !== undefined;
    }
  }
  if (buttonType(el) !== 'submit') return false;
  const root = rootOf(el);
  const form = formOwner(el, root);
  if (!form) return false;
  const owned = controlIndex(root).owned.get(form);
  return owned?.find((c) => buttonType(c) === 'submit') === el;
}

// --- what a change to a control reaches -------------------------------------------

/** The change a control's state is told as, which is in no attribute it
 *  has: what the cascade reads of it (`PSEUDO_READS`). */
export function controlChange(target: Element): HtmlChange {
  return { type: 'attributes', target, attributeName: '-rx-form' };
}

/** The attributes an answer above reads of the element it is about. */
const CONTROL_ATTRIBUTE =
  /^(?:-rx-form|type|value|required|readonly|disabled|min|max|step|pattern|minlength|maxlength|multiple|placeholder|checked|selected|name|form)$/;

/** The elements a change to what a form owns can hold it through. */
const HOLDS_CONTROLS = new Set(['form', 'fieldset', 'select', 'optgroup']);

/** What holds a control's state besides the control: the elements a selector
 *  answers for from what is in them, and `el` itself but where it is only
 *  what a control was put in or taken out of (`itself`): no selector answers
 *  for a `<div>` from what it holds. */
function holdersOf(el: Element, into: Set<Element>, itself = true): void {
  for (let at: AnyNode | null = el; at && isElement(at); at = at.parent) {
    if ((itself && at === el) || HOLDS_CONTROLS.has(tagOf(at))) into.add(at);
  }
  const owner = formOwner(el);
  if (owner) into.add(owner);
}

/** The elements an answer reads others for: every form, radio and submit
 *  button in a tree, and each fieldset around a radio, which answers for what
 *  its group came to wherever the group changed. Taken whole for a change
 *  that moves a control between forms or groups: which one it left no longer
 *  says. */
function togetherIn(root: AnyNode, into: Set<Element>): void {
  const { owned, forms } = controlIndex(root);
  for (const form of forms) into.add(form);
  for (const controls of owned.values()) {
    for (const el of controls) {
      if (tagOf(el) === 'input' && inputType(el) === 'radio') {
        into.add(el);
        for (let at = el.parent; at && isElement(at); at = at.parent) {
          if (tagOf(at) === 'fieldset') into.add(at);
        }
      } else if (buttonType(el) === 'submit') {
        into.add(el);
      }
    }
  }
}

/** Whether what came or went is, or holds, what a form reads. */
function holdsControl(node: AnyNode): boolean {
  if (!isElement(node)) return false;
  const reads = (el: Element): boolean =>
    SUBMITTABLE.has(tagOf(el)) ||
    HOLDS_CONTROLS.has(tagOf(el)) ||
    tagOf(el) === 'option' ||
    FORM_ASSOCIATED.has(el);
  if (reads(node)) return true;
  for (const el of elementsIn(node, NON_RENDERED)) if (reads(el)) return true;
  return false;
}

/**
 * The elements whose answer to one of the selectors above a change can
 * move and no key says, into `into`: a form's and a fieldset's are read from
 * what is in them, a radio's from its group and a submit button's from the
 * buttons before it, and a key reaches the element it changed alone. Told as
 * a change of `-rx-form`, an attribute nothing has, which they all read.
 */
export function controlsReached(change: HtmlChange, into: Set<Element>): void {
  if (change.type === 'attributes') {
    const el = change.target;
    const name = change.attributeName;
    if (name === 'id') {
      if (tagOf(el) === 'form') togetherIn(rootOf(el), into);
      return;
    }
    if (!CONTROL_ATTRIBUTE.test(name)) return;
    holdersOf(el, into);
    const tag = tagOf(el);
    if (
      name === 'type' ||
      name === 'form' ||
      ((name === 'name' || name === 'checked' || name === 'required') &&
        tag === 'input' &&
        inputType(el) === 'radio')
    ) {
      togetherIn(rootOf(el), into);
    }
    return;
  }
  if (change.type === 'characterData') {
    const parent = change.target.parent;
    if (!parent || !isElement(parent)) return;
    const tag = tagOf(parent);
    if (tag === 'textarea' || tag === 'option') holdersOf(parent, into);
    return;
  }
  if (change.type !== 'childList') return;
  const target = change.target;
  const held =
    change.addedNodes.some(holdsControl) ||
    change.removedNodes.some(holdsControl);
  if (!held) {
    if (isElement(target) && /^(?:textarea|option)$/.test(tagOf(target))) {
      holdersOf(target, into);
    }
    return;
  }
  if (isElement(target)) holdersOf(target, into, false);
  togetherIn(rootOf(target), into);
  for (const node of change.addedNodes) {
    if (!isElement(node)) continue;
    if (SUBMITTABLE.has(tagOf(node))) into.add(node);
    for (const el of elementsIn(node, NON_RENDERED)) {
      if (SUBMITTABLE.has(tagOf(el))) into.add(el);
    }
  }
}
