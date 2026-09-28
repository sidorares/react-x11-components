// A text engine that does not take the document down over a face it cannot
// shape from.
//
// The engine picks the face a character is drawn in — the run's own family,
// or the system's fallback for a character that family lacks — and it can
// pick one the shaper has no glyphs in. A bitmap-only colour emoji font
// (`CBDT`), which fontconfig on most Linux desktops answers first for an
// emoji, has no outlines fontkit can make a glyph from, and its shaper
// throws on the first one. A layout that throws was a document left blank
// (`HtmlViewNode._fail`) for one character a page happened to contain:
// meetup.com's pin, in "📍 Melbourne".
//
// So a layout that throws is tried again with the characters that cannot be
// shaped in their runs' faces drawn as U+FFFD, the character that says so.
// Which characters those are is found by laying each out alone, once per
// face and character, and only a layout that threw pays for any of it. The
// stand-in is the same length in UTF-16, which every offset downstream is
// counted in: a character past the BMP becomes U+FFFD and U+FE0F, which the
// shaper folds into the one glyph, and the engine keeps U+FE0F in the face
// of the character before it rather than looking for another.
//
// A layout that throws again, stand-ins and all, throws as it did: what is
// wrong there is not one character.
import type { TextRun } from '../../richtext/index.js';
import type { FontsLike } from './inline.js';

const SAFE = new WeakMap<FontsLike, FontsLike>();

/** `engine`, answering a layout it cannot shape with stand-ins rather than
 *  a throw. One per engine, so its identity is stable for the caches keyed
 *  on it. */
export function shapingSafe(engine: FontsLike): FontsLike {
  let safe = SAFE.get(engine);
  if (!safe) {
    const cannot = new Map<string, boolean>();
    let warned = false;
    safe = {
      layout(content, style, options) {
        try {
          return engine.layout(content, style, options);
        } catch (error) {
          const stood = standIns(engine, content, style, cannot);
          if (!stood) throw error;
          if (!warned) {
            warned = true;
            warn(stood.first, error);
          }
          return engine.layout(stood.content, style, options);
        }
      },
      match: (family, style) => engine.match(family, style),
    };
    SAFE.set(engine, safe);
  }
  return safe;
}

/** `content` with each character its face cannot shape replaced, or null
 *  when there is none to replace. */
function standIns(
  engine: FontsLike,
  content: TextRun[],
  style: Record<string, unknown>,
  cannot: Map<string, boolean>,
): { content: TextRun[]; first: number } | null {
  let first = -1;
  const out = content.map((run) => {
    let text = '';
    let changed = false;
    for (const char of run.text) {
      const cp = char.codePointAt(0)!;
      if (cp < 0x80 || !cannotShape(engine, run, style, cp, cannot)) {
        text += char;
        continue;
      }
      text += cp > 0xffff ? '�️' : '�';
      changed = true;
      if (first < 0) first = cp;
    }
    return changed ? { ...run, text } : run;
  });
  return first < 0 ? null : { content: out, first };
}

function cannotShape(
  engine: FontsLike,
  run: TextRun,
  style: Record<string, unknown>,
  cp: number,
  cannot: Map<string, boolean>,
): boolean {
  // the face is the family, the weight and the slant's; the size and the
  // rest of the run change nothing about which glyphs it has
  const key = `${run.family ?? style.family}|${run.weight ?? style.weight}|${
    run.style ?? style.style
  }|${cp}`;
  let answer = cannot.get(key);
  if (answer === undefined) {
    try {
      engine.layout([{ ...run, text: String.fromCodePoint(cp) }], style, {});
      answer = false;
    } catch {
      answer = true;
    }
    cannot.set(key, answer);
  }
  return answer;
}

/** Said once an engine, in development: a page whose emoji came out as
 *  boxes with a question mark in them looks broken, and this says why. */
function warn(cp: number, error: unknown): void {
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    console?: { warn(message: string): void };
  };
  if (g.process?.env?.NODE_ENV === 'production') return;
  const code = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  g.console?.warn(
    `@react-x11/components: <Html> could not shape ${code} in the face the ` +
      'text engine chose for it, and draws U+FFFD in its place — as it does ' +
      'every character it cannot shape. A bitmap-only colour emoji font ' +
      `(CBDT) is the usual cause.\n${String((error as Error)?.message ?? error)}`,
  );
}
