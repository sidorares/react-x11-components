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
// for only if some style wants its family at its width, weight and slant
// and some character of the document falls in its `unicode-range`
// (`request`). The matching is CSS Fonts 4's (5.2): the width first, then
// the slant, then the nearest weight in the direction the spec prefers, and
// a face that fails to load is passed over for the next.
//
// **Until a face has loaded, its family is not in the list.** The text is set
// in the next family the author named, as `font-display: swap` has it, and
// the list changes when the face arrives — which is what tells every cache
// keyed by a family list, the text layouts', the metrics', ntk's, that the
// text has to be set again.
//
// **A face the text engine cannot set is not registered.** A face is drawn by
// the engine, and an engine can read a file it cannot draw every weight of:
// ntk cuts an instance out of a variable face for the weight and the size a
// style asks for, and fontkit, which does the cutting, could not cut one out
// of a WOFF2 — the container nearly every variable web font is served in.
// The throw came out of the first text layout in the family, and the
// document it took down was nextjs.org's blog, for Geist. So a face is asked
// for an instance once, before it is registered (`refusal`), and one the
// engine refuses is a source that did not load: the next is tried, and with
// none left the family stays out of the list and the text is set in the
// next one, as a browser sets it when it cannot use a font.
//
// **A WOFF2 an engine does not take is handed over as the font inside it.**
// The web serves a font as WOFF2 and as little else, and not every engine
// reads one: CoreText reads an sfnt and nothing more, so react-x11's
// `loadFont` throws for a WOFF2 on macOS, and the fontkit ntk cuts a
// variable face with cut nothing out of one. Either way the page was set in
// its fallback — nextjs.org in Arial, the family its `local()` names, where
// a browser sets it in Geist. So a file is offered as it was served, and
// where that is refused the sfnt it wraps is rebuilt (`woff2.ts`) and
// offered in its place (`_register`); only a font refused both ways is a
// source that did not load. Nothing asks which engine it is.
//
// **A variable face is set at the weight and the width its rule has for a
// style's.** The weight a style asks for is a place on the face's `wght`
// axis and its `font-stretch` one on its `wdth` axis, each clamped to the
// range its `@font-face` declares (CSS Fonts 4, 7.2), and the rule is the
// document's: the values are said here (`setting`) and handed to the engine
// with the run (`layout/axes.ts`). Left alone, ntk moves the weight axis to
// the style's weight whatever the rule declared, and CoreText, for a face
// react-x11 registered, does not move it — every weight of Geist was its
// regular on macOS. Neither engine has a width at all: bun.sh's headings,
// in Archivo at 62%, were set at its normal width, half again as wide as a
// browser sets them.
//
// **A family's faces of several widths are a name for each width.** The
// font manager picks among one name's faces by weight and slant, and CSS
// picks the width first, so a family that declares a condensed face beside
// its normal one registers the two under names of their own, and the run
// is handed the list with its width's name first (`setting`). `map` puts
// the name nearest the normal width first, which is what a list with no
// width to say is set in.
//
// A family split by `unicode-range` is registered a name per range, since the
// font manager picks among one name's faces by weight and slant alone, and
// the range that holds the most of the document's characters goes first: the
// first family is the one a run is set in, and the others are reached through
// the fallback for the characters it lacks.
//
// **A family the document declares is never the system's by that name.**
// CSS Fonts 4 (5.2) has a family defined by `@font-face` with no face
// present treated as missing, and forbids matching a platform font of the
// same name. That holds for a family whose sources are all `local()`s too,
// which is the one that used to get past: next/font declares
// `"GeistSans Fallback"` as `src: local("Arial")`, the rule was dropped for
// having no `url()`, and the name went to the text engine as written —
// where fontconfig's nearest guess for a family nobody has was Hiragino Sans
// at 400 and Gill Sans Ultra Bold at 450.
//
// A `local()` is a source like a `url()`, tried in the order `src` lists
// them, and what it comes to is **an alias**: a face the system has goes
// into the list as its family's name (`localFamily`), in the place of the
// document's, and nothing is registered. A font manager has no lookup by a
// face's name — it answers any family with its best guess — so the question
// is put as a match, and the answer is believed only when the face that
// comes back says it is the one named.
//
// What stays the application's: registering a face adds it to ntk's
// fallback chain, where it can supply a glyph no other face has to text
// anywhere in the app (react-x11's `loadFont` says so), and nothing is ever
// unregistered — the font manager has no way to. A session that visits many
// sites keeps their faces, one registration per distinct declaration.
import { loadFont, openFont } from 'react-x11';
import type { Element } from 'domhandler';

import type { FontFaceRule } from './css/parse.js';
import type { ComputedStyle } from './css/style.js';
import type { ResourceRequest, ResourceResult } from './resources.js';
import { isWoff2, sfntFromWoff2 } from './woff2.js';

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
  /** The system's family a `ready` face came to through a `local()`, which
   *  the list names in place of the group's; null for a face registered
   *  from a file. */
  local: string | null;
  /** The name the face is registered under: its group's, or where the
   *  group's faces are of more than one width, its width's. */
  name: string;
  /** The range of the `wght` axis a `ready` face's file has, or null for a
   *  file with none: a static face, or the system's. */
  wght: [number, number] | null;
  /** The `wdth` axis a `ready` face's file has — its least, default and
   *  greatest — or null for a file with none. */
  wdth: [number, number, number] | null;
}

/** The axes a registered face's file has that a style moves. */
interface FileAxes {
  wght: [number, number] | null;
  wdth: [number, number, number] | null;
}

/** A family's faces for one unicode range, which CSS matches as one face
 *  (CSS Fonts 4, 5.2): one registered name, among whose faces the font
 *  manager picks by weight and slant — or one for each width its faces
 *  declare, where they declare more than one. */
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
  /** `weight|italic|width`s the styles asked for, and the ones already
   *  asked. */
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
  /** The ones among them that are the system's (`local()`), and registered
   *  under no name: the family each came to. */
  locals: Map<string, string>;
  /** The ones whose file is a variable font with a `wght` or a `wdth`
   *  axis, and the axes. */
  axes: Map<string, FileAxes>;
  /** Faces being loaded, by `faceKey`, so a second document waits for the
   *  first document's request rather than making its own. */
  pending: Map<string, Promise<boolean>>;
  /** Whether a face the engine refused has been said (`warnRefused`). */
  warned: boolean;
}

const REGISTRIES = new WeakMap<object, Registry>();

function registryOf(app: object): Registry {
  let registry = REGISTRIES.get(app);
  if (!registry) {
    registry = {
      next: 0,
      names: new Map(),
      ready: new Set(),
      locals: new Map(),
      axes: new Map(),
      pending: new Map(),
      warned: false,
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
  /** The groups by the names they are registered under, each of a group's
   *  names where it has one for each width, which is how a list the engine
   *  is handed names one (`setting`). */
  private _groups = new Map<string, Group>();
  /** Lists → weight and slant → width → how text in them is set. */
  private _settings = new Map<
    string,
    Map<number, Map<number, FaceSetting | null>>
  >();
  /** Whether any loaded face has an axis to set, or a family faces of more
   *  than one width; null for not yet asked since the faces changed. */
  private _active: boolean | null = null;
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
        // a name for each width where there is more than one, the first
        // width's the group's: the engine picks among a name's faces by
        // weight and slant alone
        const widths = new Map<string, string>();
        for (const m of members) widths.set(widthKey(m.rule), name);
        if (widths.size > 1) {
          let first = true;
          for (const width of widths.keys()) {
            if (first) {
              first = false;
              continue;
            }
            const signature = `${groupSignature}\u0003${width}`;
            let named = registry?.names.get(signature);
            if (!named) {
              named = `html webfont ${letters(registry ? registry.next++ : order++)}`;
              registry?.names.set(signature, named);
            }
            widths.set(width, named);
          }
        }
        for (const m of members) {
          const face: Face = {
            rule: m.rule,
            element: m.element,
            group,
            family,
            state: 'idle',
            local: null,
            name: widths.get(widthKey(m.rule))!,
            wght: null,
            wdth: null,
          };
          if (registry?.ready.has(faceKey(face.name, m.rule)))
            arrive(face, registry);
          group.faces.push(face);
          made.set(m, face);
        }
        family.groups.push(group);
      }
      families.set(key, family);
    }
    this._families = families;
    this._groups.clear();
    for (const family of families.values()) {
      for (const group of family.groups) {
        for (const face of group.faces) this._groups.set(face.name, group);
      }
    }
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
        // the names its files are registered under, the width nearest the
        // normal one first, then the families its `local()`s came to
        const ready = group.faces.filter((f) => f.state === 'ready');
        for (const name of namesOf(ready)) out.push(name);
        for (const face of ready) {
          if (face.local !== null && !out.includes(face.local)) {
            out.push(face.local);
          }
        }
      }
    }
    let mapped = out.length ? out.join(', ') : this._fallback;
    // A list with a family of the document's in it stands apart from the
    // generic `monospace` alone while that family loads, though both come to
    // the same face: `note` finds the families a style wants by the list it
    // came to, and the bare generic, the UA sheet's code as often as not, is
    // no reason to load a face of the document's. `monospace, monospace` is
    // that face, normalize.css's spelling of it. The size the generic alone
    // is set at goes by the list as written (`genericMonospace`), so it does
    // not change as the family arrives.
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
    const want = `${style.fontWeight}|${style.fontStyle !== 'normal' ? 1 : 0}|${style.fontStretch}`;
    for (const family of families) family.wants.add(want);
  }

  /** Whether any face the document has loaded has an axis a style moves —
   *  a weight axis its rule declares a range of, or a width axis — or is
   *  one of a family's faces of several widths: whether `setting` has
   *  anything to say. */
  get active(): boolean {
    if (this._active === null) {
      this._active = false;
      for (const group of this._groups.values()) {
        for (const face of group.faces) {
          if (face.state !== 'ready' || face.local !== null) continue;
          if (ranged(face) || face.wdth || face.name !== group.name) {
            this._active = true;
          }
        }
      }
    }
    return this._active;
  }

  /**
   * How text in a family list — one `map` made — is set at a weight, slant
   * and width: in which list, and where on its face's axes. Null where
   * none of it is this document's to say, and the run is set as it is.
   *
   * The face is the one CSS matches (CSS Fonts 4, 5.2), among the faces
   * registered under the list's first family, which is the one text is set
   * in: the width first, then the slant, then the weight. Where it is of
   * another width than the faces under that name, its own name leads the
   * list, since the engine picks among a name's faces by weight and slant.
   *
   * CSS has the weight and the width a style asks for applied to a
   * variable face's `wght` and `wdth` axes, clamped to the ranges its
   * `@font-face` rule declares (CSS Fonts 4, 7.2): `font-weight: 100 900`
   * is every weight the file has, and under `font-weight: 400 700` text at
   * 900 is set at 700. The rule is the document's, so the values are said
   * here and handed to the engine with the run (`layout/axes.ts`). An
   * engine left to itself either moves the weight axis to the style's
   * weight, past what the rule declared — ntk — or not at all: a face
   * react-x11 registers with CoreText is drawn at its file's default, and
   * every weight of Geist on macOS was the regular. The width axis neither
   * moves.
   *
   * The weight is said only for a face whose rule declares a range of
   * them: one declared at a single weight is left as the engine sets it.
   * The width is said wherever the file has the axis and the value is not
   * its default, since no engine moves it: a rule's `auto` clamps it to
   * nothing narrower than the file's own range, as `auto` has it (4.4).
   */
  setting(
    list: string,
    weight: number,
    italic: boolean,
    stretch: number,
  ): FaceSetting | null {
    if (!this.active) return null;
    let byFace = this._settings.get(list);
    if (!byFace) this._settings.set(list, (byFace = new Map()));
    const slanted = italic ? -weight : weight;
    let byWidth = byFace.get(slanted);
    if (!byWidth) byFace.set(slanted, (byWidth = new Map()));
    let setting = byWidth.get(stretch);
    if (setting === undefined) {
      setting = null;
      const comma = list.indexOf(',');
      const first = (comma < 0 ? list : list.slice(0, comma)).trim();
      const face = bestFace(
        // the faces registered under the name, or the group's other widths
        this._groups
          .get(first)
          ?.faces.filter((f) => f.state === 'ready' && f.local === null) ?? [],
        weight,
        italic,
        stretch,
      );
      if (face) {
        const family = face.name === first ? list : leading(face.name, list);
        const variations = variationsOf(face, weight, stretch);
        if (family !== list || variations) setting = { family, variations };
      }
      byWidth.set(stretch, setting);
    }
    return setting;
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
        const [weight, italic, stretch] = want.split('|');
        for (const group of family.groups) {
          if (group.coverage <= 0) continue;
          if (
            this._pick(group, Number(weight), italic === '1', Number(stretch))
          ) {
            stale = true;
          }
        }
      }
    }
    if (stale) this._forget();
    return stale;
  }

  destroy(): void {
    this._destroyed = true;
    this._families.clear();
    this._groups.clear();
    this._forget();
  }

  /** Every list mapped before this is stale: a face arrived, or the faces
   *  changed. */
  private _forget(): void {
    this._memo.clear();
    this._sources.clear();
    this._settings.clear();
    this._active = null;
  }

  /**
   * Load the face in a group that best matches a weight, slant and width,
   * passing over the ones that failed. True when one registered before
   * this returned.
   */
  private _pick(
    group: Group,
    weight: number,
    italic: boolean,
    stretch: number,
  ): boolean {
    for (;;) {
      const face = bestFace(
        group.faces.filter((f) => f.state !== 'failed'),
        weight,
        italic,
        stretch,
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
    const key = faceKey(face.name, face.rule);
    if (registry.ready.has(key)) {
      arrive(face, registry);
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
      (s) => 'local' in s || s.format === null || READABLE.has(s.format),
    );
    let i = 0;
    let sync = true;
    /** Ask for the next source. `'ready'` registered it, `'waiting'` is
     *  waiting on the host, `'none'` has no source left. */
    const next = (): 'ready' | 'waiting' | 'none' => {
      while (i < sources.length) {
        const source = sources[i++];
        if ('local' in source) {
          // nothing to ask the host for, and nothing to wait on
          const family = this._destroyed
            ? null
            : localFamily(app, source.local, face.rule);
          if (family === null) continue;
          registry.locals.set(key, family);
          finish(true);
          if (sync) arrive(face, registry);
          else this._settled(face, true);
          return 'ready';
        }
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
          answer
            .then((result) => this._register(face, result, source.url))
            .then(after, () => after(false));
          return 'waiting';
        }
        const registered = this._register(face, answer, source.url);
        if (isPromise(registered)) {
          // a WOFF2 being handed over as the font inside it
          registered.then(after, () => after(false));
          return 'waiting';
        }
        if (registered) {
          finish(true);
          if (sync) arrive(face, registry);
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

  /**
   * Register a face's bytes under its name. False when the host
   * declined, or the font manager could not read them — a file that is not
   * a font — or read them and cannot set text in them (`refusal`), and the
   * next source is tried.
   *
   * A WOFF2 the engine does not take as served is handed over again as the
   * font inside it (`woff2.ts`), and the answer is then a promise: CoreText
   * reads no such container, so react-x11's `loadFont` refuses every one on
   * macOS, and an ntk whose fontkit cuts no instance out of one cuts it out
   * of the sfnt. Nothing here asks which engine it is: the file is offered
   * as the web served it, and rebuilt only for an engine that said no.
   */
  private _register(
    face: Face,
    result: ResourceResult | null,
    url: string,
  ): boolean | Promise<boolean> {
    if (this._destroyed || !this._app || result?.kind !== 'font') return false;
    const refused = this._set(face, result.bytes);
    if (refused === null) return true;
    if (!isWoff2(result.bytes)) return this._declined(url, refused);
    return sfntFromWoff2(result.bytes).then((sfnt) => {
      if (this._destroyed || !this._app) return false;
      const still = sfnt ? this._set(face, sfnt) : refused;
      return still === null || this._declined(url, still);
    });
  }

  /** Hand a font file to the font manager, under a face's name.
   *  Null when it registered; otherwise why the engine cannot set text in
   *  it (`refusal`), or `''` for bytes it could not read at all. */
  private _set(face: Face, bytes: Uint8Array): string | null {
    const { weight, style } = face.rule;
    const app = this._app as Parameters<typeof loadFont>[0];
    try {
      // `loadFont` opens the file first too, and finds this one opened
      const opened: OpenedFace = openFont(app, bytes);
      const refused = refusal(app, opened, this._fallback);
      if (refused !== null) return refused;
      loadFont(app, bytes, {
        family: face.name,
        // a range is registered at the weight nearest regular in it: the
        // font manager picks among a group's faces by distance from one
        // weight, and a variable face is then set at the weight asked for
        weight: Math.max(weight[0], Math.min(400, weight[1])),
        style,
      });
      const wght = opened.variationAxes?.wght;
      const wdth = opened.variationAxes?.wdth;
      const axes: FileAxes = {
        wght: wght && wght.min < wght.max ? [wght.min, wght.max] : null,
        wdth:
          wdth && wdth.min < wdth.max
            ? [wdth.min, wdth.default, wdth.max]
            : null,
      };
      if (axes.wght || axes.wdth) {
        registryOf(this._app!).axes.set(faceKey(face.name, face.rule), axes);
      }
      return null;
    } catch {
      return '';
    }
  }

  /** A source did not register, and the one the engine refused is said. */
  private _declined(url: string, why: string): false {
    if (why && this._app) warnRefused(registryOf(this._app), url, why);
    return false;
  }

  /** A face arrived, or will not. Either way the boxes are built again: an
   *  arrival changes the lists, and a failure has the next face asked for,
   *  by a family that has to be asked again to ask it. */
  private _settled(face: Face, ok: boolean): void {
    if (this._destroyed) return;
    if (ok && this._app) arrive(face, registryOf(this._app));
    else face.state = ok ? 'ready' : 'failed';
    if (!ok) face.family.asked.clear();
    this._forget();
    this._changed();
  }
}

/** A registered face is the document's to use: what the connection knows
 *  of it — the family a `local()` came to, the axes its file has — is the
 *  face's. */
function arrive(face: Face, registry: Registry): void {
  const key = faceKey(face.name, face.rule);
  const axes = registry.axes.get(key);
  face.state = 'ready';
  face.local = registry.locals.get(key) ?? null;
  face.wght = axes?.wght ?? null;
  face.wdth = axes?.wdth ?? null;
}

/** How text in a family list is set (`WebFonts.setting`): the list it is
 *  handed to the engine as, and the point on its face's axes, as an engine
 *  takes one with a run — its `variations` — or null for none. */
export interface FaceSetting {
  family: string;
  variations: Variations | null;
}

/** A point on a face's weight and width axes. */
export type Variations = Readonly<{ wght?: number; wdth?: number }>;

/** One object a point: ntk tells two runs' variations apart by identity,
 *  and would set two runs at one weight as two. */
const POINTS = new Map<string, Variations>();

/** Where on its axes a face is set at a weight and a width, or null where
 *  neither axis is the document's to move. */
function variationsOf(
  face: Face,
  weight: number,
  stretch: number,
): Variations | null {
  const range = ranged(face);
  const wght = range
    ? Math.max(range[0], Math.min(weight, range[1]))
    : undefined;
  let wdth: number | undefined;
  if (face.wdth) {
    const [least, initial, most] = face.wdth;
    const [lo, hi] = face.rule.stretch ?? [least, most];
    const value = Math.max(
      least,
      Math.min(Math.max(lo, Math.min(stretch, hi)), most),
    );
    if (value !== initial) wdth = value;
  }
  if (wght === undefined && wdth === undefined) return null;
  const key = `${wght}|${wdth}`;
  let point = POINTS.get(key);
  if (!point) {
    point =
      wdth === undefined
        ? { wght }
        : wght === undefined
          ? { wdth }
          : { wght, wdth };
    POINTS.set(key, point);
  }
  return point;
}

/** A family list with `name` first, and the rest of it as it was. */
function leading(name: string, list: string): string {
  const rest = list
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n && n !== name);
  return [name, ...rest].join(', ');
}

/** The names a group's ready faces are registered under, the width nearest
 *  the normal one first (`bestFace`), and none of the system's. */
function namesOf(ready: Face[]): string[] {
  const names: string[] = [];
  const own = ready.filter((f) => f.local === null);
  for (;;) {
    const face = bestFace(
      own.filter((f) => !names.includes(f.name)),
      400,
      false,
      100,
    );
    if (!face) return names;
    names.push(face.name);
  }
}

/** What tells a face's width from another's in a group, as written: the
 *  faces of one key are registered under one name. */
function widthKey(rule: FontFaceRule): string {
  return rule.stretch ? rule.stretch.join('-') : 'auto';
}

/** The weights a loaded face's axis is set within: the range its rule
 *  declares, inside the one its file has. Null for a face with no axis, or
 *  declared at a single weight. */
function ranged(face: Face): [number, number] | null {
  if (face.state !== 'ready' || !face.wght) return null;
  const lo = Math.max(face.rule.weight[0], face.wght[0]);
  const hi = Math.min(face.rule.weight[1], face.wght[1]);
  return face.rule.weight[0] < face.rule.weight[1] && lo <= hi
    ? [lo, hi]
    : null;
}

/** The slice of an opened face `refusal` reads: react-x11's `Font`. */
interface OpenedFace {
  variationAxes?: Record<string, { min: number; default: number; max: number }>;
  variation?(settings: Record<string, number>): unknown;
}

/** The axes a style moves without naming one: ntk sets `wght` from the
 *  weight and `opsz` from the size (its `docs/fonts.md`), the document sets
 *  `wdth` from the width (`setting`), and nothing here hands it a
 *  `font-variation-settings`. A face with none of them is set as its file
 *  has it, whatever else varies in it. */
const DRIVEN_AXES = ['wght', 'wdth', 'opsz'];

/**
 * Why the text engine cannot set text in an opened face, or null when it
 * can: the face is asked for the instance a layout will ask it for, at the
 * far end of each axis a style moves, and the answer is the engine's own.
 * What it cost unasked was the document: ntk instantiates inside `match`,
 * so the throw came out of the first layout in the family, at whatever
 * weight was not the file's default.
 *
 * Only an engine that draws through the face is asked. CoreText and
 * DirectWrite move an axis themselves, and the face react-x11 opens there
 * is fontkit's, for an application to read: what it cannot do says nothing
 * about what they draw.
 */
export function refusal(
  app: object,
  font: OpenedFace,
  family: string,
): string | null {
  const axes = font.variationAxes;
  if (!axes || typeof font.variation !== 'function') return null;
  const settings: Record<string, number> = {};
  for (const tag of DRIVEN_AXES) {
    const axis = axes[tag];
    if (!axis) continue;
    const far = axis.max !== axis.default ? axis.max : axis.min;
    if (far !== axis.default) settings[tag] = far;
  }
  if (!Object.keys(settings).length) return null;
  try {
    font.variation(settings);
    return null;
  } catch (error) {
    return instantiates(app, family)
      ? String((error as Error)?.message ?? error)
      : null;
  }
}

/** Whether the engine's faces are cut into instances as an opened one is:
 *  the face it matches a family with has `variation`, as ntk's has and a
 *  CoreText or DirectWrite one has not. An engine that cannot say — no
 *  family to match — is taken to, since what is at stake is the document. */
function instantiates(app: object, family: string): boolean {
  try {
    const fonts = (app as { fonts?: { match?(family: string): unknown } })
      .fonts;
    const face = fonts?.match?.(family) as OpenedFace | null | undefined;
    return !face || typeof face.variation === 'function';
  } catch {
    return true;
  }
}

/** Said once a connection, in development: a page set in its fallback
 *  family looks like a font that never loaded, and this says it did. */
function warnRefused(registry: Registry, url: string, why: string): void {
  if (registry.warned) return;
  registry.warned = true;
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    console?: { warn(message: string): void };
  };
  if (g.process?.env?.NODE_ENV === 'production') return;
  g.console?.warn(
    `@react-x11/components: <Html> loaded the font at ${url} and the text ` +
      'engine cannot set text in it, so its family is left out and the text ' +
      'is set in the next one — as it is for every face the engine refuses. ' +
      `A variable font served as WOFF2 is the usual cause.\n${why}`,
  );
}

/** A face's identity within a registered name. */
function faceKey(name: string, rule: FontFaceRule): string {
  return `${name}\u0000${faceSignature(rule)}`;
}

function faceSignature(rule: FontFaceRule): string {
  const range = rangeKey(rule.unicodeRange);
  const sources = rule.sources.map((s) =>
    'local' in s ? `local(${s.local})` : s.url,
  );
  return `${sources.join(' ')}@${rule.weight.join('-')}${rule.style}~${widthKey(rule)}#${range}`;
}

/** What is asked of a font manager to find a `local()`: a match, and the
 *  names of the face it answers with. Both engines' faces carry them. */
interface FontLookup {
  match?(
    family: string,
    opts: { weight: number; style: string },
  ): { familyName?: string; postscriptName?: string } | null;
}

/**
 * The family of the face a `local()` names, or null when the system has no
 * such face and the next source is tried.
 *
 * CSS Fonts 4 (4.3.1) has the name be one face's — its full name or its
 * PostScript name, never a family's, and never a platform's substitute for
 * it. A font manager has no lookup by either: it takes a family and answers
 * with its best guess, which for a name nobody has is some other font. So
 * the name is matched as a family, at the weight and slant the rule declares
 * its face to have, and the answer counts only when the face that comes back
 * says it is the one asked for: by its family, which is the full name of a
 * family's regular face and how `local()` is nearly always spelled
 * (`local(Arial)`), or by its PostScript name, where an engine finds a face
 * by one. A full name with a style in it (`local(Arial Bold)`) is no family,
 * and is not found.
 *
 * What comes back is the family and not the face: the list names it, and
 * the engine picks among its faces by the weight and slant of the text, as
 * it does for any family. Bold text in a family declared as the one face
 * `local(Arial)` is set in Arial's bold, where a browser emboldens the
 * regular.
 */
function localFamily(
  app: object,
  name: string,
  rule: FontFaceRule,
): string | null {
  const fonts = (app as { fonts?: FontLookup }).fonts;
  if (typeof fonts?.match !== 'function') return null;
  const [lo, hi] = rule.weight;
  try {
    const face = fonts.match(name, {
      weight: Math.max(lo, Math.min(400, hi)),
      style: rule.style,
    });
    const family = face?.familyName;
    if (!family) return null;
    const want = name.toLowerCase();
    return family.toLowerCase() === want ||
      face.postscriptName?.toLowerCase() === want
      ? family
      : null;
  } catch {
    // no fontconfig, or a name it could not read: not found
    return null;
  }
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
 * The face CSS Fonts 4 (5.2) matches a width, weight and slant with: the
 * width first, inside the face's range or the nearest outside it in the
 * direction the spec prefers — narrower at or below normal, wider above it
 * — then the slant, then a weight inside the face's range, then the
 * nearest outside it in the direction the spec prefers — lighter below
 * 400, heavier above 500, and between them up to 500 before down. A face
 * whose width is `auto` is matched as a normal one (4.4).
 */
export function bestFace<T extends { rule: FontFaceRule }>(
  faces: T[],
  weight: number,
  italic: boolean,
  stretch = 100,
): T | null {
  let best: T | null = null;
  let bestWidth: [number, number] = [Infinity, Infinity];
  let bestScore = Infinity;
  for (const face of faces) {
    const width = widthDistance(stretch, face.rule.stretch ?? NORMAL);
    const nearer = width[0] - bestWidth[0] || width[1] - bestWidth[1];
    if (nearer > 0) continue;
    const score =
      weightDistance(weight, face.rule.weight) +
      ((face.rule.style === 'italic') === italic ? 0 : 10000);
    if (nearer < 0 || score < bestScore) {
      best = face;
      bestWidth = width;
      bestScore = score;
    }
  }
  return best;
}

const NORMAL: [number, number] = [100, 100];

/** How far a width is from a face's range, as the order CSS tries widths
 *  in: inside it, then the preferred direction by distance, then the other
 *  (CSS Fonts 4, 5.2). Two numbers, compared in turn, since a width has no
 *  greatest value to put the other direction past. */
function widthDistance(
  want: number,
  [lo, hi]: [number, number],
): [number, number] {
  if (want >= lo && want <= hi) return [0, 0];
  const narrower = hi < want;
  return want <= 100 === narrower
    ? [1, narrower ? want - hi : lo - want]
    : [2, narrower ? want - hi : lo - want];
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
