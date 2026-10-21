// The slice of ondine this package uses, and the loader that finds it.
//
// **ondine is an optional peer, and these types are ours.** It is a
// Mermaid compiler written in Rust and shipped as WebAssembly: one module
// of 1.5 MB covers every diagram type (3.7 MB for the speed-tuned one its
// Node entry reads), compiles in some 13 ms, and renders a diagram in tens
// of microseconds. What it costs is the install: the package carries every
// per-type module twice over, as `.wasm` and as base64 in `.js`, plus the
// CLI's own dependencies — some 46 MB in all. That is node-pty's order of
// weight, not `@xterm/headless`'s, so it gets node-pty's posture: an app
// that wants diagrams installs it, and nobody else does
// (AGENTS.md, "Talking to the desktop, and optional dependencies").
//
// `import type … from 'ondine'` would put it in the type graph and make an
// app without it fail to type-check, so the surface is written out
// structurally and the value arrives through a dynamic `import()` that is
// allowed to fail — `../formula/katex.ts` makes the same call about KaTeX.
//
// ondine is at 0.0.x. Everything below is read defensively: the loader
// checks that `render` is a function and that a trivial diagram renders,
// and nothing past the SVG string and its size is relied on.

/** `render`'s options, as far as this package passes them on. */
export interface OndineRenderOptions {
  /** Lay out top-to-bottom when a left-to-right flowchart would not fit
   *  `maxWidth`. ondine's default is true. */
  autoDirection?: boolean;
  directionBreakpoint?: number;
  /** Pixels per em the layout measures labels at — 0.6 em a character. */
  fontSize?: number;
  idPrefix?: string;
  /** Source characters past which it refuses (`code: 'limit'`). */
  limit?: number;
  maxEdges?: number;
  maxWidth?: number;
  /** The clock a Gantt chart's "today" marker reads. The compiler reads
   *  none of its own. */
  now?: number;
  outputLimit?: number;
  padding?: number;
  responsive?: boolean;
}

export interface OndineLink {
  readonly href: string;
  readonly id: string;
  readonly internal: boolean;
}

/** One rendered diagram. */
export interface OndineResult {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
  /** `flowchart`, `sequence`, `gitGraph`, … */
  readonly type: string;
  readonly links: readonly OndineLink[];
}

/** What a failed render throws: ondine's `RenderError`, read
 *  structurally. */
export interface OndineError {
  readonly message: string;
  readonly code?: 'limit' | 'semantic' | 'syntax' | 'unsupported-diagram';
  readonly line?: number;
  readonly column?: number;
}

/** A loaded compiler. */
export interface OndineEngine {
  render(source: string, options?: OndineRenderOptions): OndineResult;
}

/** Whether `err` came from the compiler judging the source, rather than
 *  from the compiler failing to run. */
export function isRenderError(err: unknown): err is OndineError {
  return (
    err instanceof Error &&
    (err.name === 'RenderError' ||
      typeof (err as OndineError).code === 'string')
  );
}

interface CompilerModule {
  render?: OndineEngine['render'];
}

interface WasmModule {
  create?(options: { modules: Record<string, unknown> }): {
    render: OndineEngine['render'];
  };
}

interface AllModule {
  wasm?: unknown;
}

async function load(specifier: string): Promise<unknown> {
  // The specifier is a variable so a bundler treats this as a genuinely
  // optional import rather than failing the build where it is missing.
  return import(/* @vite-ignore */ specifier);
}

/** The engine, once it has rendered something — the first render compiles
 *  the WebAssembly, and a failure there is a failure to load. */
function proven(render: OndineEngine['render']): OndineEngine {
  const engine: OndineEngine = { render };
  try {
    engine.render('info');
  } catch (err) {
    if (!isRenderError(err)) throw err;
  }
  return engine;
}

async function attempt(): Promise<OndineEngine> {
  // Node and Bun: `ondine/compiler` reads the speed-tuned module from the
  // package with `node:fs`.
  let first: unknown;
  try {
    const mod = (await load('ondine/compiler')) as CompilerModule;
    if (typeof mod.render === 'function') return proven(mod.render);
  } catch (err) {
    first = err;
  }
  // Anywhere without that filesystem — a bundle — the size-tuned module,
  // inlined as base64, through the WebAssembly entry.
  const [wasm, all] = (await Promise.all([
    load('ondine/compiler/wasm'),
    load('ondine/compiler/wasm/all'),
  ])) as [WasmModule, AllModule];
  if (typeof wasm.create !== 'function' || all.wasm === undefined) {
    throw first ?? new TypeError('ondine did not export what was expected');
  }
  const compiler = wasm.create({ modules: { all: all.wasm } });
  return proven(compiler.render.bind(compiler));
}

let cached: Promise<OndineEngine> | null = null;

/**
 * Load ondine, once. Deliberately **not** cached as a rejection: a failed
 * load is almost always "not installed", and an app that installs it and
 * re-mounts should get a fresh try.
 */
export function loadOndine(): Promise<OndineEngine> {
  if (cached) return cached;
  cached = attempt().catch((err: unknown) => {
    cached = null;
    throw err;
  });
  return cached;
}
