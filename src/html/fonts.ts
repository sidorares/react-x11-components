// `@font-face`: the families a document brings with it.
//
// A face is a resource like an image — asked for through `onResource`, as
// `{ kind: 'font' }`, and handed back as the file's bytes — and nothing loads
// without the host, as nothing else does. What is particular to fonts is
// where one goes once it has loaded: into the connection's font manager,
// where the text engine finds a family by name. That manager is the whole
// application's, so three rules keep a document's fonts the document's.
//
// **A face is registered under a name nothing else has.** A page that
// declares `font-family: Inter` must not change what `Inter` means to the
// window around it, to the next tab, or to a page that ships another file
// under the same name — an icon font called `Icons` on two sites is two sets
// of glyphs. So each group of faces is registered as `html webfont <letters>`
// and the cascade's `font-family` lists are rewritten to it (`map`). The name
// is keyed by the family, the unicode range and every face's URLs, weight and
// slant: two documents that declare a family the same way share one
// registration, and a document that declares it differently gets its own.
// (Letters only, because the name also reaches fontconfig, where `-12` would
// read as a size.)
//
// **A face loads when the page uses it, as a browser loads one.** A Google
// Fonts sheet declares a family seven times over, once per script, and a
// self-hosted family often declares every weight it has. The cascade reports
// each computed style (`note`), and after the boxes are built a face is asked
// for only if some style wants its family at its weight and slant and some
// character of the document falls in its `unicode-range` (`request`). The
// matching is CSS Fonts 4's (5.2): the slant first, then the nearest weight
// in the direction the spec prefers, and a face that fails to load is passed
// over for the next.
//
// **Until a face has loaded, its family is not in the list.** The text is set
// in the next family the author named, as `font-display: swap` has it, and
// the list changes when the face arrives — which is what tells every cache
// keyed by a family list, the text layouts', the metrics', ntk's, that the
// text has to be set again.
//
// A family split by `unicode-range` is registered a name per range, since the
// font manager picks among one name's faces by weight and slant alone, and
// the range that holds the most of the document's characters goes first: the
// first family is the one a run is set in, and the others are reached through
// the fallback for the characters it lacks.
//
// What stays the application's: registering a face adds it to ntk's
// fallback chain, where it can supply a glyph no other face has to text
// anywhere in the app (react-x11's `loadFont` says so), and nothing is ever
// unregistered — the font manager has no way to. A session that visits many
// sites keeps their faces, one registration per distinct declaration.
import { loadFont } from 'react-x11';
import type { Element } from 'domhandler';

import type { FontFaceRule } from './css/parse.js';
import type { ComputedStyle } from './css/style.js';
import type { ResourceRequest, ResourceResult } from './resources.js';

/** What the cascade asks of the document's families (`Cascade`). */
export interface FontFamilies {
  /** A computed `font-family` list, as the text engine should see it. */
  map(list: string): string;
  /** A style was computed: its family, weight and slant are wanted. */
  note(style: ComputedStyle): void;
}

/** A `@font-face` rule, and the element whose sheet declared it — the one a
 *  request names. */
export interface DeclaredFace {
  rule: FontFaceRule;
  element: Element;
}

type Ask = (
  request: ResourceRequest,
) => Promise<ResourceResult | null> | ResourceResult | null;

/** The formats a font manager reads. A source hinted as anything else — an
 *  `embedded-opentype` for old Internet Explorer, an `svg` font — is not
 *  asked for; one with no hint is. */
const READABLE = new Set([
  'woff2',
  'woff',
  'truetype',
  'opentype',
  'ttf',
  'otf',
  'collection',
  'woff2-variations',
  'woff-variations',
  'truetype-variations',
  'opentype-variations',
]);

interface Face {
  rule: FontFaceRule;
  element: Element;
  group: Group;
  family: Family;
  /** Where loading got to. `idle` has not been asked for. */
  state: 'idle' | 'loading' | 'ready' | 'failed';
}

/** A family's faces for one unicode range: one registered name, among whose
 *  faces the font manager picks by weight and slant. */
interface Group {
  name: string;
  ranges: [number, number][] | null;
  faces: Face[];
  /** How many of the document's distinct code points the range holds. */
  coverage: number;
  order: number;
}

interface Family {
  groups: Group[];
  /** `weight|italic`s the styles asked for, and the ones already asked. */
  wants: Set<string>;
  asked: Set<string>;
}

/** What one connection has registered, shared by every document on it. */
interface Registry {
  next: number;
  /** A group's signature → the name it is registered under. */
  names: Map<string, string>;
  /** Faces registered, by `faceKey`. */
  ready: Set<string>;
  /** Faces being loaded, by `faceKey`, so a second document waits for the
   *  first document's request rather than making its own. */
  pending: Map<string, Promise<boolean>>;
}

const REGISTRIES = new WeakMap<object, Registry>();

function registryOf(app: object): Registry {
  let registry = REGISTRIES.get(app);
  if (!registry) {
    registry = {
      next: 0,
      names: new Map(),
      ready: new Set(),
      pending: new Map(),
    };
    REGISTRIES.set(app, registry);
  }
  return registry;
}

/** `0 → a`, `25 → z`, `26 → ba`: a counter as letters. */
function letters(n: number): string {
  let out = '';
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  } while (n > 0);
  return out;
}

export class WebFonts implements FontFamilies {
  private _app: object | null;
  private _ask: Ask;
  private _changed: () => void;
  private _fallback: string;
  private _families = new Map<string, Family>();
  /** Every face, in the order the sheets declared them. */
  private _faces: Face[] = [];
  /** What `setFaces` was last handed, to tell a restyle that changed no
   *  face from one that did. */
  private _declared = '';
  /** Lists as the author wrote them → as the engine should see them. */
  private _memo = new Map<string, string>();
  /** Lists as the engine sees them → the declared families they came from,
   *  for `note`, which is handed a computed style and so the second. Two
   *  lists that come to one string share an entry, which can ask for a face
   *  a little early; never for one nothing wants. */
  private _sources = new Map<string, Family[]>();
  /** The document's characters, as the last `request` saw them. */
  private _text: string | null = null;
  private _seen = new Set<number>();
  private _points: Uint32Array = new Uint32Array(0);
  private _destroyed = false;

  constructor(app: unknown, ask: Ask, changed: () => void, fallback: string) {
    this._app = app !== null && typeof app === 'object' ? app : null;
    this._ask = ask;
    this._changed = changed;
    this._fallback = fallback;
  }

  /** The family a list comes to when every name in it was the document's
   *  own and none has loaded — the document's default. */
  setFallback(family: string): void {
    if (family === this._fallback) return;
    this._fallback = family;
    this._forget();
  }

  /**
   * The faces the document's sheets declare, after a restyle — in sheet
   * order, the ones whose `@media` holds. A face declared as it was keeps
   * what it had loaded, and so does one another document on the connection
   * declared the same way.
   */
  setFaces(declared: DeclaredFace[]): void {
    const signature = declared
      .map(
        (d) => `${d.rule.family.toLowerCase()}\u0001${faceSignature(d.rule)}`,
      )
      .join('\u0002');
    if (signature === this._declared) {
      // the same faces, in elements a re-parse made again
      this._faces.forEach((face, i) => (face.element = declared[i].element));
      return;
    }
    this._declared = signature;

    // a family's faces, by range, in the order they were declared
    const byFamily = new Map<string, Map<string, DeclaredFace[]>>();
    for (const face of declared) {
      const key = face.rule.family.toLowerCase();
      let ranges = byFamily.get(key);
      if (!ranges) byFamily.set(key, (ranges = new Map()));
      const range = rangeKey(face.rule.unicodeRange);
      let list = ranges.get(range);
      if (!list) ranges.set(range, (list = []));
      list.push(face);
    }
    const registry = this._app ? registryOf(this._app) : null;
    const previous = this._families;
    const families = new Map<string, Family>();
    const made = new Map<DeclaredFace, Face>();
    let order = 0;
    for (const [key, ranges] of byFamily) {
      const before = previous.get(key);
      const family: Family = {
        groups: [],
        // what the styles wanted is still wanted, and asked for again: under
        // another name it is another registration
        wants: before ? before.wants : new Set(),
        asked: new Set(),
      };
      for (const [range, members] of ranges) {
        const groupSignature = `${key}\u0001${range}\u0001${members
          .map((m) => faceSignature(m.rule))
          .join('\u0002')}`;
        let name = registry?.names.get(groupSignature);
        if (!name) {
          name = `html webfont ${letters(registry ? registry.next++ : order)}`;
          registry?.names.set(groupSignature, name);
        }
        const group: Group = {
          name,
          ranges: members[0].rule.unicodeRange,
          faces: [],
          coverage: members[0].rule.unicodeRange ? 0 : Infinity,
          order: order++,
        };
        for (const m of members) {
          const ready = registry?.ready.has(faceKey(name, m.rule)) ?? false;
          const face: Face = {
            rule: m.rule,
            element: m.element,
            group,
            family,
            state: ready ? 'ready' : 'idle',
          };
          group.faces.push(face);
          made.set(m, face);
        }
        family.groups.push(group);
      }
      families.set(key, family);
    }
    this._families = families;
    this._faces = declared.map((d) => made.get(d)!);
    // the ranges are new, and so is what they cover
    if (this._text !== null) this._measure(this._text, true);
    this._forget();
  }

  map(list: string): string {
    if (!this._families.size) return list;
    const known = this._memo.get(list);
    if (known !== undefined) return known;
    const out: string[] = [];
    const used: Family[] = [];
    for (const raw of list.split(',')) {
      const name = raw.trim();
      if (!name) continue;
      const family = this._families.get(name.toLowerCase());
      if (!family) {
        out.push(name);
        continue;
      }
      used.push(family);
      for (const group of orderedGroups(family)) {
        if (group.faces.some((f) => f.state === 'ready')) out.push(group.name);
      }
    }
    let mapped = out.length ? out.join(', ') : this._fallback;
    // The generic `monospace` as the whole of a list is set smaller than any
    // other list (the cascade's `FIXED_SIZE`), and the author's list, with a
    // family of the document's in it, is not that list. Left as `monospace`
    // while its family loads, `"Courier Prime", monospace` was set at 13/16
    // and jumped to its size when the face arrived; `monospace, monospace`
    // is the same face at the size the author's list has — normalize.css's
    // spelling of it.
    if (used.length && /^monospace$/i.test(mapped)) {
      mapped = 'monospace, monospace';
    }
    this._memo.set(list, mapped);
    if (used.length) {
      const sources = this._sources.get(mapped);
      if (!sources) this._sources.set(mapped, used);
      else for (const f of used) if (!sources.includes(f)) sources.push(f);
    }
    return mapped;
  }

  note(style: ComputedStyle): void {
    const families = this._sources.get(style.fontFamily);
    if (!families) return;
    const want = `${style.fontWeight}|${style.fontStyle !== 'normal' ? 1 : 0}`;
    for (const family of families) family.wants.add(want);
  }

  /**
   * Ask for the faces the styles noted since the last call want, for the
   * characters `text` holds — the document's own. True when the lists the
   * boxes were styled with are out of date already: a host that answers at
   * once registered a face before this returned, or the document's text
   * changed which range of a family should lead. The caller builds its boxes
   * again.
   */
  request(text: string): boolean {
    if (!this._families.size || this._destroyed) return false;
    let stale = text !== this._text && this._measure(text, false);
    for (const family of this._families.values()) {
      for (const want of family.wants) {
        if (family.asked.has(want)) continue;
        family.asked.add(want);
        const [weight, italic] = want.split('|');
        for (const group of family.groups) {
          if (group.coverage <= 0) continue;
          if (this._pick(group, Number(weight), italic === '1')) stale = true;
        }
      }
    }
    if (stale) this._forget();
    return stale;
  }

  destroy(): void {
    this._destroyed = true;
    this._families.clear();
    this._forget();
  }

  /** Every list mapped before this is stale: a face arrived, or the faces
   *  changed. */
  private _forget(): void {
    this._memo.clear();
    this._sources.clear();
  }

  /**
   * Load the face in a group that best matches a weight and slant, passing
   * over the ones that failed. True when one registered before this
   * returned.
   */
  private _pick(group: Group, weight: number, italic: boolean): boolean {
    for (;;) {
      const face = bestFace(
        group.faces.filter((f) => f.state !== 'failed'),
        weight,
        italic,
      );
      if (!face || face.state !== 'idle') return false;
      const outcome = this._load(face);
      if (outcome !== 'failed') return outcome === 'ready';
    }
  }

  /**
   * Count what of the document each group's range holds, for a new text.
   * An append — a stream — only reads what it appended. True when a family's
   * loaded ranges come in another order than they did.
   */
  private _measure(text: string, rescan: boolean): boolean {
    const before = rescan ? '' : this._readyOrder();
    const from =
      !rescan && this._text !== null && text.startsWith(this._text)
        ? this._text.length
        : 0;
    if (from === 0) this._seen.clear();
    const seen = this._seen;
    const size = seen.size;
    for (let i = from; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          seen.add(((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000);
          i += 1;
          continue;
        }
      }
      seen.add(code);
    }
    this._text = text;
    if (seen.size !== size || from === 0) {
      this._points = Uint32Array.from(seen).sort();
      for (const family of this._families.values()) {
        for (const group of family.groups) {
          if (!group.ranges) continue;
          let count = 0;
          for (const [lo, hi] of group.ranges) {
            count += countBetween(this._points, lo, hi);
          }
          // a range the text has reached only now — the Cyrillic further
          // down a streamed page — is asked for with the weights the
          // family was asked at before it was reached
          if (group.coverage <= 0 && count > 0) family.asked.clear();
          group.coverage = count;
        }
      }
    }
    return !rescan && this._readyOrder() !== before;
  }

  /** The loaded groups' names, family by family, in the order `map` puts
   *  them. */
  private _readyOrder(): string {
    let out = '';
    for (const family of this._families.values()) {
      for (const group of orderedGroups(family)) {
        if (group.faces.some((f) => f.state === 'ready'))
          out += `${group.name},`;
      }
      out += ';';
    }
    return out;
  }

  /** Load a face, trying its sources in order: registered before this
   *  returned, waiting on the host, or failed with nothing left to try. */
  private _load(face: Face): 'ready' | 'loading' | 'failed' {
    const app = this._app;
    if (!app) {
      face.state = 'failed';
      return 'failed';
    }
    const registry = registryOf(app);
    const key = faceKey(face.group.name, face.rule);
    if (registry.ready.has(key)) {
      face.state = 'ready';
      return 'ready';
    }
    face.state = 'loading';
    const waiting = registry.pending.get(key);
    if (waiting) {
      void waiting.then((ok) => this._settled(face, ok));
      return 'loading';
    }
    let settle!: (ok: boolean) => void;
    registry.pending.set(
      key,
      new Promise<boolean>((resolve) => (settle = resolve)),
    );
    const finish = (ok: boolean): void => {
      registry.pending.delete(key);
      if (ok) registry.ready.add(key);
      settle(ok);
    };

    const sources = face.rule.sources.filter(
      (s) => s.format === null || READABLE.has(s.format),
    );
    let i = 0;
    let sync = true;
    /** Ask for the next source. `'ready'` registered it, `'waiting'` is
     *  waiting on the host, `'none'` has no source left. */
    const next = (): 'ready' | 'waiting' | 'none' => {
      while (i < sources.length) {
        const source = sources[i++];
        let answer: ReturnType<Ask>;
        try {
          answer = this._ask({
            url: source.url,
            kind: 'font',
            element: face.element,
          });
        } catch {
          continue;
        }
        if (isPromise(answer)) {
          answer.then(
            (result) => after(this._register(face, result)),
            () => after(false),
          );
          return 'waiting';
        }
        if (this._register(face, answer)) {
          finish(true);
          if (sync) face.state = 'ready';
          else this._settled(face, true);
          return 'ready';
        }
      }
      return 'none';
    };
    const after = (registered: boolean): void => {
      if (registered) {
        finish(true);
        this._settled(face, true);
      } else if (next() === 'none') {
        finish(false);
        this._settled(face, false);
      }
    };
    const outcome = next();
    sync = false;
    if (outcome === 'none') {
      finish(false);
      face.state = 'failed';
      return 'failed';
    }
    return outcome === 'ready' ? 'ready' : 'loading';
  }

  /** Register a face's bytes under its group's name. False when the host
   *  declined, or the font manager could not read them — a `.woff2` on
   *  macOS, whose CoreText reads no such container, or a file that is not a
   *  font — and the next source is tried. */
  private _register(face: Face, result: ResourceResult | null): boolean {
    if (this._destroyed || !this._app || result?.kind !== 'font') return false;
    const { weight, style } = face.rule;
    try {
      loadFont(this._app as Parameters<typeof loadFont>[0], result.bytes, {
        family: face.group.name,
        // a range is registered at the weight nearest regular in it: the
        // font manager picks among a group's faces by distance from one
        // weight, and a variable face is then set at the weight asked for
        weight: Math.max(weight[0], Math.min(400, weight[1])),
        style,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** A face arrived, or will not. Either way the boxes are built again: an
   *  arrival changes the lists, and a failure has the next face asked for,
   *  by a family that has to be asked again to ask it. */
  private _settled(face: Face, ok: boolean): void {
    if (this._destroyed) return;
    face.state = ok ? 'ready' : 'failed';
    if (!ok) face.family.asked.clear();
    this._forget();
    this._changed();
  }
}

/** A face's identity within a registered name. */
function faceKey(name: string, rule: FontFaceRule): string {
  return `${name}\u0000${faceSignature(rule)}`;
}

function faceSignature(rule: FontFaceRule): string {
  const range = rangeKey(rule.unicodeRange);
  return `${rule.sources.map((s) => s.url).join(' ')}@${rule.weight.join(
    '-',
  )}${rule.style}#${range}`;
}

function rangeKey(ranges: [number, number][] | null): string {
  return ranges ? ranges.map(([a, b]) => `${a}-${b}`).join(',') : '*';
}

/** A family's groups, the one holding the most of the document first. */
function orderedGroups(family: Family): Group[] {
  if (family.groups.length < 2) return family.groups;
  return [...family.groups].sort(
    (a, b) => b.coverage - a.coverage || a.order - b.order,
  );
}

/**
 * The face CSS Fonts 4 (5.2) matches a weight and slant with: the slant
 * first, then a weight inside the face's range, then the nearest outside it
 * in the direction the spec prefers — lighter below 400, heavier above 500,
 * and between them up to 500 before down.
 */
export function bestFace<T extends { rule: FontFaceRule }>(
  faces: T[],
  weight: number,
  italic: boolean,
): T | null {
  let best: T | null = null;
  let bestScore = Infinity;
  for (const face of faces) {
    const score =
      weightDistance(weight, face.rule.weight) +
      ((face.rule.style === 'italic') === italic ? 0 : 10000);
    if (score < bestScore) {
      best = face;
      bestScore = score;
    }
  }
  return best;
}

function weightDistance(want: number, [lo, hi]: [number, number]): number {
  if (want >= lo && want <= hi) return 0;
  if (want >= 400 && want <= 500) {
    if (lo > want && lo <= 500) return lo - want;
    if (hi < want) return 1000 + (want - hi);
    return 2000 + (lo - want);
  }
  if (want < 400) return hi < want ? want - hi : 1000 + (lo - want);
  return lo > want ? lo - want : 1000 + (want - hi);
}

/** How many of the sorted `points` lie in `[lo, hi]`. */
function countBetween(points: Uint32Array, lo: number, hi: number): number {
  return lowerBound(points, hi + 1) - lowerBound(points, lo);
}

function lowerBound(points: Uint32Array, value: number): number {
  let a = 0;
  let b = points.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (points[mid] < value) a = mid + 1;
    else b = mid;
  }
  return a;
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return typeof (value as Promise<T> | null)?.then === 'function';
}
