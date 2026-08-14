// The attribute model, and SGR as a reducer over it. Pure — no parser, no
// palette, no React — so every rule below is asserted directly.
//
// **Colour is kept as intent, not as pixels.** A span says "ANSI 2" or
// "0x00cd00", and which pixels that is stays the renderer's question. That is
// what lets one parsed capture render correctly against a light theme and a
// dark one, what makes a `colors.palette` prop mean something, and what lets
// a test assert the colour a program asked for rather than the one a theme
// happened to resolve. It is the split `../codeblock/` already makes between
// `codeRuns` (tokens) and `codeBlockLook` (the palette).

/** A colour a program asked for. Absent means "the terminal's default". */
export type AnsiColor =
  | { readonly kind: 'ansi'; readonly index: number }
  | { readonly kind: 'rgb'; readonly value: number };

/** SGR 4's sub-parameter, as the styles it names. */
export type AnsiUnderline = 'single' | 'double' | 'curly' | 'dotted' | 'dashed';

/**
 * Everything about a run of characters except the characters.
 *
 * A field that is absent is the terminal's default, which is why nothing here
 * is `| null`: "no background" and "the default background" are the same
 * statement, and a renderer that has to tell them apart is a renderer with a
 * bug waiting in it.
 */
export interface AnsiAttrs {
  readonly fg?: AnsiColor;
  readonly bg?: AnsiColor;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: AnsiUnderline;
  /** SGR 58. Only meaningful with `underline`. */
  readonly underlineColor?: AnsiColor;
  /** SGR 5/6. Carried, never animated — see the PRD. */
  readonly blink?: boolean;
  readonly inverse?: boolean;
  /** SGR 8. The text is in the capture and is painted in the background
   *  colour, exactly as the terminal painted it. */
  readonly conceal?: boolean;
  readonly strike?: boolean;
  readonly overline?: boolean;
  /** OSC 8. Not an SGR attribute, and deliberately not reset by SGR 0. */
  readonly href?: string;
}

/** The default attributes, shared: a plain run compares equal by identity. */
export const PLAIN: AnsiAttrs = Object.freeze({});

/** The 256 palette entries, interned — a screen of colour allocates nothing. */
const ANSI_COLORS: readonly AnsiColor[] = Array.from(
  { length: 256 },
  (_, index) => Object.freeze({ kind: 'ansi', index }) as AnsiColor,
);

/** An indexed colour, clamped to the palette. */
export function ansiColor(index: number): AnsiColor {
  return ANSI_COLORS[Math.max(0, Math.min(255, index | 0))]!;
}

/** A direct colour, from three channels. */
export function rgbColor(r: number, g: number, b: number): AnsiColor {
  const clamp = (v: number): number => Math.max(0, Math.min(255, v | 0));
  return Object.freeze({
    kind: 'rgb',
    value: (clamp(r) << 16) | (clamp(g) << 8) | clamp(b),
  });
}

/** An absent CSI parameter. `-1` rather than 0, because `CUF` defaults to 1
 *  and `EL` defaults to 0 — only the dispatch site knows which. */
export const ABSENT = -1;

/** Parameter `i`, or `dflt` when the program left it out. */
export function param(
  params: readonly number[][],
  i: number,
  dflt: number,
): number {
  const value = params[i]?.[0];
  return value === undefined || value === ABSENT ? dflt : value;
}

/** The flag fields, so the setter below stays one line per SGR code. */
type BooleanField =
  | '_bold'
  | '_dim'
  | '_italic'
  | '_blink'
  | '_inverse'
  | '_conceal'
  | '_strike'
  | '_overline';

const UNDERLINES: readonly (AnsiUnderline | undefined)[] = [
  undefined,
  'single',
  'double',
  'curly',
  'dotted',
  'dashed',
];

/**
 * The current attributes, mutated by SGR and frozen on demand.
 *
 * `attrs()` hands back one immutable record until something changes, so every
 * cell written between two SGR sequences shares it — which is what lets the
 * line flusher coalesce a span with `===` instead of comparing twelve fields
 * per character.
 */
export class Style {
  private _fg: AnsiColor | undefined;
  private _bg: AnsiColor | undefined;
  private _ul: AnsiUnderline | undefined;
  private _ulColor: AnsiColor | undefined;
  private _bold = false;
  private _dim = false;
  private _italic = false;
  private _blink = false;
  private _inverse = false;
  private _conceal = false;
  private _strike = false;
  private _overline = false;
  private _href: string | undefined;
  private _frozen: AnsiAttrs | null = PLAIN;

  /** The shared record for everything written under the current attributes. */
  attrs(): AnsiAttrs {
    if (this._frozen) return this._frozen;
    const out: Record<string, unknown> = {};
    if (this._fg) out.fg = this._fg;
    if (this._bg) out.bg = this._bg;
    if (this._bold) out.bold = true;
    if (this._dim) out.dim = true;
    if (this._italic) out.italic = true;
    if (this._ul) out.underline = this._ul;
    if (this._ul && this._ulColor) out.underlineColor = this._ulColor;
    if (this._blink) out.blink = true;
    if (this._inverse) out.inverse = true;
    if (this._conceal) out.conceal = true;
    if (this._strike) out.strike = true;
    if (this._overline) out.overline = true;
    if (this._href !== undefined) out.href = this._href;
    this._frozen = Object.freeze(out) as AnsiAttrs;
    return this._frozen;
  }

  /** SGR 0. **Does not clear the hyperlink**: OSC 8 is its own state, and a
   *  program that colours part of a link does not expect to end it. */
  reset(): void {
    this._fg = undefined;
    this._bg = undefined;
    this._ul = undefined;
    this._ulColor = undefined;
    this._bold = false;
    this._dim = false;
    this._italic = false;
    this._blink = false;
    this._inverse = false;
    this._conceal = false;
    this._strike = false;
    this._overline = false;
    this._frozen = this._href === undefined ? PLAIN : null;
  }

  /** OSC 8's open and close. */
  setHref(href: string | undefined): void {
    if (this._href === href) return;
    this._href = href;
    this._frozen = null;
  }

  /** Apply one SGR sequence. `params` is the CSI parameter list, each entry a
   *  group of `:`-separated sub-parameters. */
  apply(params: readonly number[][]): void {
    if (params.length === 0) {
      this.reset();
      return;
    }
    for (let i = 0; i < params.length; i++) {
      const group = params[i]!;
      const head = group[0];
      // An omitted SGR parameter is 0 — `\e[;31m` is a reset then red.
      const code = head === undefined || head === ABSENT ? 0 : head;
      switch (code) {
        case 0:
          this.reset();
          break;
        case 1:
          this._set('_bold', true);
          break;
        case 2:
          this._set('_dim', true);
          break;
        case 3:
          this._set('_italic', true);
          break;
        case 4:
          // `4` is a single underline; `4:0`…`4:5` name the style, which is
          // one of the two things `@xterm/headless` does not expose and a
          // static parser can simply read (AGENTS.md, "No escape hatches").
          this._underline(group.length > 1 ? (group[1] ?? 0) : 1);
          break;
        case 5:
        case 6:
          this._set('_blink', true);
          break;
        case 7:
          this._set('_inverse', true);
          break;
        case 8:
          this._set('_conceal', true);
          break;
        case 9:
          this._set('_strike', true);
          break;
        // 21 is "bold off" in ECMA-48 and "double underline" in every
        // terminal a capture was made on. The capture wins.
        case 21:
          this._underline(2);
          break;
        case 22:
          this._set('_bold', false);
          this._set('_dim', false);
          break;
        case 23:
          this._set('_italic', false);
          break;
        case 24:
          this._underline(0);
          break;
        case 25:
          this._set('_blink', false);
          break;
        case 27:
          this._set('_inverse', false);
          break;
        case 28:
          this._set('_conceal', false);
          break;
        case 29:
          this._set('_strike', false);
          break;
        case 39:
          this._color('_fg', undefined);
          break;
        case 49:
          this._color('_bg', undefined);
          break;
        case 53:
          this._set('_overline', true);
          break;
        case 55:
          this._set('_overline', false);
          break;
        case 59:
          this._color('_ulColor', undefined);
          break;
        case 38:
        case 48:
        case 58: {
          const read = extendedColor(params, i, group);
          i = read.next;
          if (read.ok) {
            this._color(
              code === 38 ? '_fg' : code === 48 ? '_bg' : '_ulColor',
              read.color,
            );
          }
          break;
        }
        default:
          if (code >= 30 && code <= 37)
            this._color('_fg', ansiColor(code - 30));
          else if (code >= 40 && code <= 47)
            this._color('_bg', ansiColor(code - 40));
          else if (code >= 90 && code <= 97)
            this._color('_fg', ansiColor(code - 90 + 8));
          else if (code >= 100 && code <= 107)
            this._color('_bg', ansiColor(code - 100 + 8));
          // Everything else — the font selectors (10–20), the ideogram
          // attributes (60–65), the proportional-spacing pair — is ignored
          // rather than dropped-and-counted: they are legal SGR that changes
          // nothing this model represents, not a sequence that went unhonoured.
          break;
      }
    }
  }

  private _set(field: BooleanField, value: boolean): void {
    const self = this as unknown as Record<BooleanField, boolean>;
    if (self[field] === value) return;
    self[field] = value;
    this._frozen = null;
  }

  private _color(
    field: '_fg' | '_bg' | '_ulColor',
    value: AnsiColor | undefined,
  ): void {
    const self = this as unknown as Record<string, AnsiColor | undefined>;
    if (self[field] === value) return;
    self[field] = value;
    this._frozen = null;
  }

  private _underline(kind: number): void {
    // `0` is off and is the one index whose `undefined` is an answer rather
    // than a miss — `?? 'single'` over the whole lookup would make `4:0` and
    // `24` turn the underline *on*.
    const next = kind === 0 ? undefined : (UNDERLINES[kind] ?? 'single');
    if (this._ul === next) return;
    this._ul = next;
    this._frozen = null;
  }
}

/** What a `38`/`48`/`58` consumed, and what it produced. */
interface ExtendedRead {
  ok: boolean;
  color: AnsiColor | undefined;
  /** The index the SGR loop should continue from. */
  next: number;
}

/**
 * `38;5;n`, `38;2;r;g;b` and their `:` twins.
 *
 * The colon form carries everything in one group, and its `2` variant may
 * carry a colour-space id the ITU form reserves — `38:2::r:g:b`, six
 * sub-parameters with an empty third. Both lengths are accepted, because both
 * are in captures.
 */
function extendedColor(
  params: readonly number[][],
  i: number,
  group: readonly number[],
): ExtendedRead {
  if (group.length > 1) {
    const selector = group[1];
    if (selector === 5) {
      return { ok: true, color: ansiColor(group[2] ?? 0), next: i };
    }
    if (selector === 2) {
      const base = group.length >= 6 ? 3 : 2;
      return {
        ok: true,
        color: rgbColor(
          group[base] ?? 0,
          group[base + 1] ?? 0,
          group[base + 2] ?? 0,
        ),
        next: i,
      };
    }
    return { ok: false, color: undefined, next: i };
  }
  const selector = param(params, i + 1, ABSENT);
  if (selector === 5) {
    return { ok: true, color: ansiColor(param(params, i + 2, 0)), next: i + 2 };
  }
  if (selector === 2) {
    return {
      ok: true,
      color: rgbColor(
        param(params, i + 2, 0),
        param(params, i + 3, 0),
        param(params, i + 4, 0),
      ),
      next: i + 4,
    };
  }
  // A selector nobody recognises: swallow it alone rather than guessing how
  // many parameters it would have eaten, so the rest of the sequence still
  // applies instead of being read as colour channels.
  return { ok: false, color: undefined, next: i + 1 };
}
