// A page's script engine: one `node:vm` context a document, hardened as
// docs/prd-html-scripts.md says, with the DOM facade (`dom.ts`) installed
// in it and every way in from the host a `vm.Script` run with a timeout.
//
// What keeps the page in its context, each closing one of the PRD's leaks:
//
//   1. The global is the context's own object (`DONT_CONTEXTIFY`, or a
//      null-prototype object where the runtime has none), so
//      `this.constructor.constructor` is the context's `Function`.
//   2. No host object is ever handed in. The bridge is a host function, and
//      it is in the facade's closure and nowhere a page can reach; what goes
//      in is strings, through `__in`, a data property the facade defines
//      and a page cannot turn into a setter; what comes back is primitives.
//   3. `Error.prepareStackTrace` is locked before any page code runs, so no
//      call site hands a page a function of the host's.
//   4. Every function of the host's that calls into the context is strict
//      ESM, and it calls only through a `vm.Script`, never a page function
//      directly, so no `caller` leads out.
//   5. Every script compiled into the context has a host callback for
//      `import()`, and what it rejects with is the context's own
//      `TypeError`. Where a page's `import()` finds none — and where the
//      runtime ignores one, Node without `--experimental-vm-modules` — it
//      rejects with an error of the host's, whose `constructor.constructor`
//      is the host's `Function`: `import('x').catch((e) =>
//      e.constructor.constructor('return process')())` was the host's
//      `process`, on Node and on Bun. So scripts run only where the runtime
//      honours the callback (`SCRIPTS_CONTAINED`).
//
// A runaway page is stopped by the timeout, microtasks included
// (`microtaskMode: 'afterEvaluate'`), and the page is usable after it. That
// mode has one other side: a promise the host settles runs its callbacks at
// the context's next evaluation, which is why every answer comes in through
// an entry. Nothing bounds the heap; the process — the tab — is the bound.
//
// **Not a boundary against a hostile page.** Node says so of `vm`, and the
// PRD's threat model says what is: the process, which is a weak one today.
// This is why scripts are off unless a switch turns them on.
import vm from 'node:vm';

import { installDom } from './dom.js';
import type { Bridge, Primitive } from './dom.js';

export interface EngineOptions {
  /** How long any one entry may run, in milliseconds. */
  timeout: number;
  /** An entry ran past it and was stopped. */
  onTimeout(): void;
  /** Where the engine says what went wrong. */
  log(level: string, text: string): void;
  /** The outermost entry is done: the moment to hand the tree's changes
   *  to `<Html>`, once a task. */
  settled(): void;
  /** Which global the context has: its own object (`DONT_CONTEXTIFY`),
   *  one over an object with no prototype, or the first where the runtime
   *  keeps a script's `var`s in it (`createPageContext`) — the default.
   *  Named, so a test holds both to the same escapes on any runtime. */
  global?: 'auto' | 'own' | 'object';
}

/**
 * Whether this runtime can keep a page's `import()` in its context: Bun,
 * and Node with `--experimental-vm-modules` — what `vm.SourceTextModule`
 * being there says on both, since the flag that makes the class is the one
 * that makes Node call a script's `importModuleDynamically` at all. The
 * browser starts every pane with it (`PANE_FLAGS`), and its own process
 * from `npm run examples:browser`. Where it is false, no engine is made,
 * and a page is a browser's with scripts off.
 */
export const SCRIPTS_CONTAINED = !!(vm as { SourceTextModule?: unknown })
  .SourceTextModule;

/** The facade's source, made once, with the one name a transpiler may call
 *  that the facade does not define: tsx keeps a function's name with a
 *  `__name` helper at the module's top, which the context has to have. */
const INSTALL = `(function () {
  'use strict';
  const __name = (target, value) => {
    try { Object.defineProperty(target, 'name', { value, configurable: true }); } catch {}
    return target;
  };
  const install = (${installDom.toString()});
  const bridge = globalThis.__bridge;
  delete globalThis.__bridge;
  install(bridge);
})()`;

/** The engines alive in this process, by their context's
 *  `Promise.prototype`: what tells a page's unhandled rejection from the
 *  host's (`watchRejections`). */
const ENGINES = new Map<object, ScriptEngine>();

/**
 * A page's promise rejected with nothing to catch it is the page's to
 * report, as a browser reports one, and not the process's to die of: in a
 * `vm` context with its own microtask queue it reaches `process` as any
 * other would, and its default is to end the process — the tab. Which
 * context a promise is of is its prototype's, read without running anything
 * of the page's: a promise is no proxy. Anything else is thrown again, as
 * if this had not listened.
 */
const onRejection = (reason: unknown, promise: Promise<unknown>): void => {
  const engine = ENGINES.get(Object.getPrototypeOf(promise) as object);
  if (engine) {
    engine.rejected();
    return;
  }
  throw reason;
};

/** Listen, where nothing took the listener away since. */
function watchRejections(): void {
  if (!process.listeners('unhandledRejection').includes(onRejection)) {
    process.on('unhandledRejection', onRejection);
  }
}

/** The context's own `TypeError`, by the context, for what an `import()` is
 *  refused with (`refuseImport`). */
const TYPE_ERRORS = new WeakMap<vm.Context, new (message: string) => object>();

/** An `import()` refused, with the context's own `TypeError`: the callback
 *  every script compiled into a page's context has, and the context itself
 *  for code with no script to be found from. */
function refuseImport(
  context: vm.Context,
): (specifier: string) => Promise<never> {
  return (specifier) => {
    let PageTypeError = TYPE_ERRORS.get(context);
    if (!PageTypeError) {
      PageTypeError = new vm.Script('TypeError').runInContext(context) as new (
        message: string,
      ) => object;
      TYPE_ERRORS.set(context, PageTypeError);
    }
    return Promise.reject(
      new PageTypeError(
        `Failed to fetch dynamically imported module: ${String(specifier)}. Modules are not run by this browser.`,
      ),
    );
  };
}

const CONTEXT_OPTIONS: vm.CreateContextOptions = {
  name: 'page',
  microtaskMode: 'afterEvaluate',
  // a page's own `eval` and `new Function` are the context's, and an
  // `on…` attribute is compiled with one; WebAssembly is not phase 1's
  codeGeneration: { strings: true, wasm: false },
};

/** Whether a context's global keeps a script's `var`s: Bun 1.4's
 *  `DONT_CONTEXTIFY` context loses them, where Node's keeps them. */
let dontContextifyKeepsVars: boolean | null = null;

/**
 * A context for a page. Its global is the context's own ordinary object
 * (`DONT_CONTEXTIFY`) where the runtime has one that works, and else a
 * global over an object with no prototype, which closes the same leak —
 * `this.constructor` reaches nothing of the host's either way. Bun 1.4 has
 * the constant and drops every top-level `var` in a context made with it
 * (`var a = 5; typeof a` is `'undefined'`), which is every classic script's
 * way to share a name, so it is asked of once, and a runtime that answers
 * wrong gets the other.
 */
function createPageContext(
  global: 'auto' | 'own' | 'object' = 'auto',
): vm.Context {
  // An `import()` in code no script of the host's is found from is refused
  // by the context's own callback, handed nothing of which context it is.
  const make = (
    sandbox: object | typeof vm.constants.DONT_CONTEXTIFY,
  ): vm.Context => {
    let context: vm.Context | null = null;
    const refuse = (specifier: string) => refuseImport(context!)(specifier);
    context = vm.createContext(sandbox, {
      ...CONTEXT_OPTIONS,
      importModuleDynamically: refuse as never,
    });
    return context;
  };
  const constant = vm.constants?.DONT_CONTEXTIFY;
  if (constant !== undefined && global === 'own') return make(constant);
  if (
    constant !== undefined &&
    global === 'auto' &&
    dontContextifyKeepsVars !== false
  ) {
    const context = make(constant);
    dontContextifyKeepsVars ??=
      new vm.Script('var __probe = 1; typeof __probe').runInContext(context) ===
      'number';
    if (dontContextifyKeepsVars) return context;
  }
  return make(Object.create(null));
}

export class ScriptEngine {
  private readonly _context: vm.Context;
  private readonly _promises: object;
  private _depth = 0;
  private _broken = false;
  private _disposed = false;

  /** The entries, compiled for this context: what an `import()` in what
   *  they run is refused with is this context's (`refuseImport`). */
  private readonly _entries = new Map<string, vm.Script>();
  private readonly _refuse: (specifier: string) => Promise<never>;

  constructor(
    bridge: Bridge,
    private readonly _options: EngineOptions,
  ) {
    if (!SCRIPTS_CONTAINED) {
      throw new Error(
        "A page's scripts are not run where its import() would reach the host: run Node with --experimental-vm-modules.",
      );
    }
    this._context = createPageContext(this._options.global);
    this._refuse = refuseImport(this._context);
    // the facade is compiled with the callback too: a page's `eval`, `new
    // Function` and string timers run from inside it, and are found from it
    const run = (code: string): unknown =>
      new vm.Script(code, {
        importModuleDynamically: this._refuse as never,
      }).runInContext(this._context, {
        timeout: this._options.timeout,
      });
    run(
      `Object.defineProperty(Error, 'prepareStackTrace', ` +
        `{ value: undefined, writable: false, configurable: false });`,
    );
    // the one host object that ever goes in, taken out of the global by
    // the facade before any page code runs
    (this._context as Record<string, unknown>).__bridge = bridge;
    run(INSTALL);
    this._promises = run('Promise.prototype') as object;
    ENGINES.set(this._promises, this);
    watchRejections();
  }

  /** An entry's script, compiled once for this context. */
  private _entry(name: string): vm.Script {
    let script = this._entries.get(name);
    if (!script) {
      script = new vm.Script(`${name}()`, {
        filename: `engine:${name}`,
        importModuleDynamically: this._refuse as never,
      });
      this._entries.set(name, script);
    }
    return script;
  }

  /** A page's classic script, run in the global scope, as `currentScript`
   *  the element with `script`'s id (0 for none). Whether it ran to its
   *  end; what it threw is reported in the page. */
  exec(code: string, url: string, script: number): boolean {
    return this.call('__exec', [code, url, script]) === true;
  }

  /** Run an entry of the facade's with its input, and answer what it
   *  answered: a primitive, or undefined where it was stopped or failed. */
  call(name: string, input: unknown): Primitive {
    if (this._broken || this._disposed) return undefined;
    try {
      (this._context as Record<string, unknown>).__in = JSON.stringify(input);
    } catch {
      // the page made the slot read-only: it has stopped listening
      this._broken = true;
      this._options.log('error', 'The page broke its script engine.');
      return undefined;
    }
    this._depth += 1;
    try {
      const out = this._entry(name).runInContext(this._context, {
        timeout: this._options.timeout,
      });
      return out === null || typeof out !== 'object'
        ? (out as Primitive)
        : undefined;
    } catch (error) {
      // Node makes the timeout's error in the context's realm, so it is no
      // `instanceof Error` here, and Bun in the host's; its `code` says
      // which it is on both. Nothing of the page's is thrown out of an
      // entry — the facade reports what a page throws — so it is Node's.
      let code: unknown;
      try {
        code = (error as { code?: unknown } | null)?.code;
      } catch {}
      if (code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        this._options.onTimeout();
      } else {
        this._options.log(
          'error',
          `The page's script engine failed in ${name}.`,
        );
      }
      return undefined;
    } finally {
      this._depth -= 1;
      if (!this._depth && !this._disposed) this._options.settled();
    }
  }

  /** A promise of the page's rejected and nothing caught it. */
  rejected(): void {
    this._options.log('error', 'Uncaught (in promise)');
  }

  dispose(): void {
    this._disposed = true;
    ENGINES.delete(this._promises);
  }
}
