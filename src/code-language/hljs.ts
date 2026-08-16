// highlight.js as a `Language` — the fourth adapter, beside the built-in
// stream tokenizers, Lezer and TextMate.
//
// It is here because ntk used to ship one (`highlightCode`, a
// MarkdownView-internal that this package reached for by name) and ntk's
// document widgets are being decommissioned. What the adapter buys is
// **breadth**: the built-in tokenizers cover the languages worth writing by
// hand — js/ts/jsx/tsx, json, shell, sql, glsl — and highlight.js's `common`
// build covers about thirty more, at a level of accuracy nobody wants to
// re-derive. A fence tagged `python` or `rust` or `yaml` has somewhere to go.
//
// **No dependency, like `textmate.ts`.** The app hands over an initialized
// highlight.js and this module is typed against the shape it uses, not
// against the package:
//
// ```ts
// import hljs from 'highlight.js/lib/common';
// import { hljsLanguage } from '@react-x11/components/code-language';
//
// <Markdown resolveLanguage={(tag) => hljsLanguage({ hljs, name: tag })} />
// ```
//
// `import type … from 'highlight.js'` would put the package in the type
// graph and an app that never installs it could no longer type-check against
// this one — the same reasoning `ical.ts` and `lezer.ts` are written from.
// It also means the app chooses the build: `lib/common` (~30 languages),
// `lib/core` plus registrations (only what it registers), or the full one.
//
// ## Whole-document, and what that costs
//
// highlight.js has no incremental mode: it tokenizes a string, start to
// finish, and there is no way to resume from a line. So the tokenizer here
// highlights the whole document and slices it per line — which the seam
// explicitly allows ("engines that work document-wide cache internally and
// slice") — and re-runs on edit, lazily, at most once per generation.
//
// That is the right trade for what this is for: a markdown fence, a `<Code>`
// block, a file of a few hundred lines. It is the wrong tool for a megabyte
// under a caret, and a `<CodeEditor>` over one should be on a Lezer grammar,
// which is incremental by construction.
import type {
  Language,
  LanguageData,
  Token,
  Tokenizer,
  TokenizerHost,
} from './types.js';

/**
 * The slice of highlight.js this adapter uses — `hljs` from
 * `highlight.js/lib/common`, `highlight.js/lib/core`, or the full build,
 * all of which have these two methods.
 */
export interface HljsLike {
  /** The language definition for a name or alias, or undefined. */
  getLanguage(name: string): unknown;
  /** Highlight `code`; `value` is HTML with `<span class="hljs-…">` scopes. */
  highlight(
    code: string,
    options: { language: string; ignoreIllegals?: boolean },
  ): { value: string };
}

export interface HljsLanguageOptions {
  /** An initialized highlight.js. */
  hljs: HljsLike;
  /** The language name or alias — a fence tag is exactly this. */
  name: string;
  /**
   * Extra scope → token-type entries, merged over the defaults. For a
   * language whose grammar invents a scope, or to re-aim one: highlight.js
   * calls a CSS class `attribute` and a theme may want it as `propertyName`
   * in one language and `variableName` in another.
   */
  scopeTypes?: Readonly<Record<string, string>>;
  /** Comment syntax and the rest, for `<CodeEditor>`'s own commands.
   * highlight.js does not describe any of this, so it is the caller's. */
  data?: LanguageData;
}

/**
 * highlight.js scope → the token vocabulary in `types.ts` (Lezer's, which is
 * what the built-in themes style). Scopes not listed here inherit the
 * enclosing span's type, so a nested `title` inside `function` still paints;
 * a top-level unknown scope paints plain rather than invisible.
 *
 * Dotted scopes are matched first at their full name and then at their base,
 * because highlight.js emits `title.function_` as two classes and the base
 * is a reasonable answer whenever the specific one is not listed.
 */
const DEFAULT_SCOPE_TYPES: Readonly<Record<string, string>> = {
  keyword: 'keyword',
  operator: 'operator',
  punctuation: 'punctuation',
  built_in: 'keyword',
  type: 'typeName',
  class: 'className',
  'title.class': 'className',
  'title.class.inherited': 'className',
  title: 'function',
  'title.function': 'function',
  'title.function.invoke': 'function',
  function: 'function',
  section: 'keyword',
  literal: 'atom',
  symbol: 'atom',
  string: 'string',
  'char.escape': 'escape',
  regexp: 'string2',
  subst: 'variableName',
  addition: 'string',
  deletion: 'comment',
  number: 'number',
  comment: 'comment',
  doctag: 'docComment',
  quote: 'comment',
  meta: 'meta',
  'meta.prompt': 'meta',
  'meta keyword': 'meta',
  'meta string': 'string',
  name: 'typeName',
  tag: 'typeName',
  attr: 'propertyName',
  attribute: 'propertyName',
  property: 'propertyName',
  params: 'variableName',
  variable: 'variableName',
  'variable.language': 'self',
  'variable.constant': 'atom',
  'template-variable': 'variableName',
  'template-tag': 'meta',
  'selector-tag': 'typeName',
  'selector-id': 'labelName',
  'selector-class': 'className',
  'selector-attr': 'propertyName',
  'selector-pseudo': 'modifier',
  'selector-pseudo-class': 'modifier',
  link: 'string',
  bullet: 'punctuation',
  code: 'string2',
  formula: 'string2',
  emphasis: 'comment',
  strong: 'keyword',
  strike: 'comment',
};

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
};

const unescapeHtml = (text: string): string =>
  text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m]);

/** One flat run of the highlighted document. Runs concatenate back to
 *  exactly the input — the offsets below depend on it. */
interface Run {
  text: string;
  type: string | null;
}

/**
 * Flatten highlight.js's `<span>` tree into runs.
 *
 * Parsing the emitted HTML rather than driving a custom emitter is
 * deliberate: the emitter interface is internal and has changed shape
 * between majors, while the HTML — escaped text inside `hljs-`-classed spans
 * — is the documented output every consumer of the library stands on.
 */
function runsOf(
  html: string,
  scopeTypes: Readonly<Record<string, string>>,
): Run[] {
  const runs: Run[] = [];
  const stack: Array<string | null> = [null];
  const emit = (text: string, type: string | null): void => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && last.type === type) last.text += text;
    else runs.push({ text, type });
  };
  // a `<span class=…>` open, a close, a run of text, or a stray `<`
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== undefined) {
      const classes = m[1]
        .split(/\s+/)
        .filter(Boolean)
        // highlight.js writes the leading scope with the `hljs-` prefix and
        // any sub-scope bare, sometimes with a trailing `_` to dodge CSS
        // keyword collisions: `class="hljs-title function_"`
        .map((c) => (c.startsWith('hljs-') ? c.slice(5) : c).replace(/_$/, ''));
      const scope = classes.join('.');
      const inherited = stack[stack.length - 1];
      stack.push(
        scopeTypes[scope] ?? scopeTypes[classes[0]] ?? inherited ?? null,
      );
    } else if (m[0] === '</span>') {
      if (stack.length > 1) stack.pop();
    } else {
      emit(unescapeHtml(m[0]), stack[stack.length - 1]);
    }
  }
  return runs;
}

/** Runs → one token array per line. Untyped runs become gaps, which is what
 *  "plain text" looks like to the painter. */
function linesOf(runs: readonly Run[], lineCount: number): Token[][] {
  const out: Token[][] = Array.from({ length: lineCount }, () => []);
  let line = 0;
  let col = 0;
  for (const run of runs) {
    // a run may straddle newlines; each piece is a token on its own line
    const pieces = run.text.split('\n');
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0) {
        line += 1;
        col = 0;
      }
      const piece = pieces[i];
      if (!piece) continue;
      if (run.type && line < out.length) {
        out[line].push({ from: col, to: col + piece.length, type: run.type });
      }
      col += piece.length;
    }
  }
  return out;
}

/**
 * A `Language` backed by highlight.js. Returns `null` when this build of
 * highlight.js does not know `name` — which is the answer `resolveLanguage`
 * and `languageForTag` both speak, so an unknown fence tag falls through to
 * plain text instead of throwing.
 *
 * ```ts
 * import hljs from 'highlight.js/lib/common';
 * hljsLanguage({ hljs, name: 'python' });   // a Language
 * hljsLanguage({ hljs, name: 'klingon' });  // null
 * ```
 */
export function hljsLanguage(options: HljsLanguageOptions): Language | null {
  const { hljs, name, scopeTypes: extra, data } = options;
  const language = String(name ?? '').toLowerCase();
  if (!language || !hljs.getLanguage(language)) return null;

  const scopeTypes = extra
    ? { ...DEFAULT_SCOPE_TYPES, ...extra }
    : DEFAULT_SCOPE_TYPES;

  return {
    name: language,
    ...(data ? { data } : null),
    createTokenizer(_host: TokenizerHost): Tokenizer {
      // The editor's live line array. Held by reference on purpose: it is
      // edited in place, and `edit()` is guaranteed after every mutation, so
      // re-reading it here is what keeps the paint in step with the text.
      let lines: readonly string[] = [];
      let cache: Token[][] | null = null;

      const rehighlight = (): Token[][] => {
        if (cache) return cache;
        let html: string;
        try {
          html = hljs.highlight(lines.join('\n'), {
            language,
            ignoreIllegals: true,
          }).value;
        } catch {
          // a grammar that throws on this input is not an error worth
          // surfacing — the code is still readable unhighlighted
          cache = lines.map(() => []);
          return cache;
        }
        cache = linesOf(runsOf(html, scopeTypes), lines.length);
        return cache;
      };

      return {
        setLines(next) {
          lines = next;
          cache = null;
        },
        edit() {
          // no incremental path to take: drop the cache and let the next
          // pull re-run the whole document
          cache = null;
        },
        lineTokens(line) {
          return rehighlight()[line] ?? [];
        },
      };
    },
  };
}
