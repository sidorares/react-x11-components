// The Lezer adapter: plug a CodeMirror-ecosystem grammar (`@lezer/javascript`,
// `@lezer/python`, `@lezer/rust`, …) into `<CodeEditor language>`.
//
// ```ts
// import { parser } from '@lezer/javascript';
// <CodeEditor language={lezerLanguage({ name: 'js', parser })} />
// ```
//
// Dependency policy, following the `ical.js` precedent (AGENTS.md): the app
// installs the grammar package; `@lezer/highlight` — the small (~100 KB,
// one-dependency) module that turns a Lezer tree into styled ranges — is
// loaded with a dynamic `import()` that is allowed to fail. It is declared
// as an *optional peer* rather than an optional dependency because every
// `@lezer/<lang>` grammar already depends on it: the app that has a parser
// to pass in has the highlighter on disk, and an optionalDependency would
// install it even for apps that never touch this file. The parser itself is
// typed structurally (`LezerParserLike`) so this package's type graph stays
// free of lezer's.
//
// Tokenization is asynchronous by design: a reparse is scheduled on a short
// debounce after each edit, and the editor repaints when `invalidate` fires
// — stale colours for a few tens of milliseconds, never a blocked keystroke.
// (Incremental reparse via `TreeFragments` is a planned refinement; the
// seam already carries the edit ranges it needs.)
import { startTimeout, stopTimeout } from './timers.js';
import type { TimerId } from './timers.js';
import type {
  Language,
  LanguageData,
  LineEdit,
  Token,
  Tokenizer,
  TokenizerHost,
} from './types.js';

/** The slice of a Lezer `LRParser` this adapter calls. */
export interface LezerParserLike {
  parse(input: string): unknown;
}

/** The slice of `@lezer/highlight` the adapter uses — also the injection
 * point tests (and bundlers that dislike dynamic import) use. */
export interface LezerHighlightLike {
  highlightTree(
    tree: unknown,
    highlighter: unknown,
    putStyle: (from: number, to: number, classes: string) => void,
  ): void;
  classHighlighter: unknown;
}

export interface LezerLanguageOptions {
  name: string;
  parser: LezerParserLike;
  data?: LanguageData;
  /** Pass the `@lezer/highlight` module yourself (tests, static bundles);
   * defaults to `import('@lezer/highlight')`. */
  highlight?: LezerHighlightLike | Promise<LezerHighlightLike>;
  /** Reparse debounce, ms (default 30). */
  delay?: number;
}

/** `classHighlighter` emits `tok-keyword tok-comment …`; the editor's token
 * vocabulary *is* those names unprefixed, so the mapping is a strip. */
function classesToType(classes: string): string {
  const first = classes.split(' ', 1)[0];
  return first.startsWith('tok-') ? first.slice(4) : first;
}

class LezerTokenizer implements Tokenizer {
  private lines: readonly string[] = [''];
  private tokens: Token[][] = [];
  private hl: LezerHighlightLike | null = null;
  private failed = false;
  private timer: TimerId = null;
  private disposed = false;
  private parseSeq = 0;

  constructor(
    private readonly options: LezerLanguageOptions,
    private readonly host: TokenizerHost,
  ) {
    const supplied = options.highlight;
    const loading = supplied
      ? Promise.resolve(supplied)
      : // a bare specifier the bundler must not pre-resolve: see header
        import('@lezer/highlight' as string).then(
          (m) => m as unknown as LezerHighlightLike,
        );
    loading.then(
      (module_) => {
        if (this.disposed) return;
        this.hl = module_;
        this.schedule(0);
      },
      () => {
        // No highlighter on disk: paint plain, once, quietly — the same
        // "absence is a normal state" rule the desktop calendar follows.
        this.failed = true;
      },
    );
  }

  setLines(lines: readonly string[]): void {
    this.lines = lines;
    this.tokens = [];
    this.schedule(0);
  }

  edit(_edit: LineEdit): void {
    // Full reparse on the debounce; the old tokens keep painting meanwhile.
    // The LineEdit is unused today — it is what the TreeFragments-based
    // incremental version will consume.
    this.schedule(this.options.delay ?? 30);
  }

  lineTokens(line: number): readonly Token[] {
    return this.tokens[line] ?? [];
  }

  dispose(): void {
    this.disposed = true;
    stopTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (this.failed || !this.hl || this.disposed) return;
    stopTimeout(this.timer);
    this.timer = startTimeout(() => {
      this.timer = null;
      this.reparse();
    }, delay);
  }

  private reparse(): void {
    const hl = this.hl;
    if (!hl || this.disposed) return;
    const seq = ++this.parseSeq;
    const lines = this.lines;
    const text = lines.join('\n');
    let tree: unknown;
    try {
      tree = this.options.parser.parse(text);
    } catch {
      return; // a grammar that throws paints plain rather than crashing
    }
    // line starts, for slicing document offsets into per-line tokens
    const starts = new Array<number>(lines.length);
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      starts[i] = offset;
      offset += lines[i].length + 1;
    }
    const perLine: Token[][] = lines.map(() => []);
    let line = 0;
    const put = (from: number, to: number, classes: string): void => {
      const type = classesToType(classes);
      while (line + 1 < lines.length && starts[line + 1] <= from) line++;
      let l = line;
      let a = from;
      while (a < to && l < lines.length) {
        const lineEnd = starts[l] + lines[l].length;
        const b = Math.min(to, lineEnd);
        if (b > a) {
          perLine[l].push({ from: a - starts[l], to: b - starts[l], type });
        }
        a = Math.max(b, starts[l] + lines[l].length + 1);
        l++;
      }
    };
    try {
      hl.highlightTree(tree, hl.classHighlighter, put);
    } catch {
      return;
    }
    if (seq !== this.parseSeq || this.disposed || this.lines !== lines) return;
    this.tokens = perLine;
    this.host.invalidate(0);
  }
}

/** Wrap a Lezer parser as a {@link Language}. */
export function lezerLanguage(options: LezerLanguageOptions): Language {
  return {
    name: options.name,
    data: options.data,
    createTokenizer: (host) => new LezerTokenizer(options, host),
  };
}
