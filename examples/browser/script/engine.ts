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
import { types } from 'node:util';
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
  /** A module's source, by its URL, through the browser's network, or null
   *  where there is none. Without it a module imports nothing. */
  load?(url: string): Promise<string | null>;
  /** What a classic script's `import()` resolves against: the document's
   *  address, which `history.pushState` moves. */
  base?(): string;
}

/** `vm.SourceTextModule`, where the runtime has it: Bun always, Node behind
 *  `--experimental-vm-modules`, which the browser starts a page's pane with
 *  (`PANE_FLAGS`). Typed here, since `@types/node` leaves it out of `vm`'s
 *  declarations for the flag. */
interface PageModule {
  readonly identifier: string;
  readonly status: string;
  link(
    linker: (specifier: string, referencing: PageModule) => Promise<PageModule>,
  ): Promise<void>;
  evaluate(options?: { timeout?: number }): Promise<void>;
}
type ModuleClass = new (
  source: string,
  options: {
    context: vm.Context;
    identifier: string;
    initializeImportMeta(
      meta: Record<string, unknown>,
      module: PageModule,
    ): void;
    importModuleDynamically(
      specifier: string,
      referrer: { identifier?: string },
    ): Promise<PageModule>;
  },
) => PageModule;
const SourceTextModule = (vm as unknown as { SourceTextModule?: ModuleClass })
  .SourceTextModule;

/**
 * Whether this runtime can keep a page's `import()` in its context: Bun,
 * and Node with `--experimental-vm-modules` — what `vm.SourceTextModule`
 * being there says on both, since the flag that makes the class is the one
 * that makes Node call a script's `importModuleDynamically` at all. The
 * browser starts every pane with it (`PANE_FLAGS`), and its own process
 * from `npm run examples:browser`. Where it is false, no engine is made,
 * and a page is a browser's with scripts off.
 */
export const SCRIPTS_CONTAINED = !!SourceTextModule;

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

/** Whether a module `import()` hands over is the module: Bun 1.4 calls the
 *  host for one in a context and resolves the page's promise with a
 *  namespace that has none of its exports, which a page cannot tell from a
 *  module that exports nothing. Asked once, of a throwaway context. */
let dynamicImportWorks: Promise<boolean> | null = null;
function askDynamicImport(): Promise<boolean> {
  dynamicImportWorks ??= (async () => {
    if (!SourceTextModule) return false;
    try {
      const context = vm.createContext(Object.create(null), {
        microtaskMode: 'afterEvaluate',
      });
      const probe = new SourceTextModule('export const ok = 1;', {
        context,
        identifier: 'probe:',
        initializeImportMeta() {},
        importModuleDynamically: () => Promise.reject(new Error('none')),
      });
      await probe.link(() => Promise.reject(new Error('none')));
      await probe.evaluate();
      new vm.Script('import("probe:").then((m) => { globalThis.ok = m.ok; })', {
        importModuleDynamically: (async () => probe) as never,
      }).runInContext(context);
      for (let i = 0; i < 4; i += 1) {
        await new Promise((r) => setTimeout(r, 0));
        if (new vm.Script('globalThis.ok').runInContext(context) === 1) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  })();
  return dynamicImportWorks;
}

/** A module specifier as a URL (HTML 8.1.5.5, "resolve a module
 *  specifier"): one that starts with `/`, `./` or `../`, against `base`, or
 *  a whole URL. A bare one — `lodash` — is an import map's, which there is
 *  none of here. */
function resolveSpecifier(specifier: string, base: string): string {
  if (/^(?:\/|\.\/|\.\.\/)/.test(specifier)) {
    return new URL(specifier, base).href;
  }
  try {
    return new URL(specifier).href;
  } catch {
    throw new TypeError(
      `Failed to resolve module specifier "${specifier}". Relative references must start with either "/", "./", or "../".`,
    );
  }
}
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
  global: 'auto' | 'own' | 'object',
  importer: (specifier: string) => Promise<unknown>,
): vm.Context {
  // an `import()` in code no script of the host's is found from is the
  // context's own to answer
  const make = (
    sandbox: object | typeof vm.constants.DONT_CONTEXTIFY,
  ): vm.Context =>
    vm.createContext(sandbox, {
      ...CONTEXT_OPTIONS,
      importModuleDynamically: importer as never,
    });
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

  /** This document's module map (HTML 8.1.4.6): one module a URL, however
   *  many import it — and each linked once and evaluated once, which the
   *  runtime allows a module only once, however many `import()`s are
   *  waiting on it at the same time. */
  private readonly _modules = new Map<string, Promise<PageModule>>();
  private readonly _linked = new WeakMap<PageModule, Promise<void>>();
  private readonly _evaluated = new WeakMap<PageModule, Promise<void>>();
  /** The entries, compiled for this context, so that an `import()` in what
   *  they run is this document's (`_dynamic`). */
  private readonly _entries = new Map<string, vm.Script>();
  /** The callback every script compiled into the context has, and the
   *  context itself: a page's `import()`, resolved against the document. */
  private readonly _importer: (specifier: string) => Promise<PageModule>;
  /** The context's own `TypeError`, taken before any page code runs: what a
   *  failed `import()` rejects with is the page's, never a host error, whose
   *  `constructor.constructor` is the host's `Function`. */
  private readonly _TypeError: new (message: string) => object;

  constructor(
    bridge: Bridge,
    private readonly _options: EngineOptions,
  ) {
    if (!SCRIPTS_CONTAINED) {
      throw new Error(
        "A page's scripts are not run where its import() would reach the host: run Node with --experimental-vm-modules.",
      );
    }
    this._importer = (specifier) => {
      const done = this._dynamic(specifier, this._options.base?.() ?? '');
      // The page's promise settles in the context's own queue, which runs
      // only as the host enters the context (`microtaskMode`): an entry,
      // once what settled it has.
      done.then(this._drainLater, this._drainLater);
      return done;
    };
    this._context = createPageContext(
      this._options.global ?? 'auto',
      this._importer,
    );
    // the facade is compiled with the callback too: a page's `eval`, `new
    // Function` and string timers run from inside it, and are found from it
    const run = (code: string): unknown =>
      new vm.Script(code, {
        importModuleDynamically: this._importer as never,
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
    this._TypeError = run('TypeError') as new (message: string) => object;
    ENGINES.set(this._promises, this);
    watchRejections();
  }

  /** An entry's script, compiled once for this context. */
  private _entry(name: string): vm.Script {
    let script = this._entries.get(name);
    if (!script) {
      script = new vm.Script(`${name}()`, {
        filename: `engine:${name}`,
        importModuleDynamically: this._importer as never,
      });
      this._entries.set(name, script);
    }
    return script;
  }

  /**
   * A page's module script (HTML 8.1.4.4): compiled, its imports fetched and
   * linked, and evaluated with the timeout every entry has. Resolves once it
   * has run to its first `await` — a top-level `await` goes on in the
   * page's own time — to whether it ran; what failed is reported in the
   * page, as a classic script's is.
   */
  async module(code: string, url: string, external: boolean): Promise<boolean> {
    if (this._broken || this._disposed) return false;
    let root: PageModule;
    try {
      root = this._compile(code, url);
      // one fetched is the module at its URL for whatever imports it; an
      // inline one is at the document's, which it is no module of
      if (external && !this._modules.has(url)) {
        this._modules.set(url, Promise.resolve(root));
      }
      await this._link(root);
    } catch (error) {
      // a fetch that failed, or a module that did not parse or link: the
      // host's error or the runtime's, reported in the page as its own
      this._fault(error);
      return false;
    }
    if (this._disposed) return false;
    return this._evaluate(root);
  }

  /** A module, compiled in this context: `import.meta.url` its address,
   *  and an `import()` in it resolved against that. */
  private _compile(code: string, url: string): PageModule {
    return new SourceTextModule!(code, {
      context: this._context,
      identifier: url,
      initializeImportMeta: (meta, module) => {
        meta.url = module.identifier;
      },
      importModuleDynamically: (specifier, referrer) =>
        this._dynamic(specifier, referrer.identifier ?? url),
    });
  }

  /** The module at a URL, fetched and compiled once (`_modules`). */
  private _fetch(url: string): Promise<PageModule> {
    let module = this._modules.get(url);
    if (!module) {
      const load = this._options.load;
      module = (load ? load(url) : Promise.resolve(null)).then((code) => {
        if (code === null) throw new TypeError(`Failed to fetch module ${url}`);
        return this._compile(code, url);
      });
      this._modules.set(url, module);
    }
    return module;
  }

  /** What a static `import` names, linked: the same module wherever it is
   *  imported from. */
  private readonly _linker = async (
    specifier: string,
    referencing: PageModule,
  ): Promise<PageModule> => {
    const module = await this._fetch(
      resolveSpecifier(specifier, referencing.identifier),
    );
    // Linked with the module that imports it, when that one is: an
    // `import()` of it later links nothing again, which the runtime
    // refuses, and waits for that link where it is still going.
    if (!this._linked.has(module)) {
      this._linked.set(
        module,
        this._linked.get(referencing) ?? Promise.resolve(),
      );
    }
    return module;
  };

  /**
   * `import()`: the module, fetched and linked, for the runtime to evaluate
   * and hand the page. What failed is the context's own `TypeError`, with
   * the message read here from an error of ours; and where the runtime would
   * hand over an empty namespace (`askDynamicImport`), it fails rather than
   * lie to the page.
   */
  private async _dynamic(specifier: string, base: string): Promise<PageModule> {
    let module: PageModule;
    try {
      if (!(await askDynamicImport())) {
        throw new TypeError(
          'import() is not supported in this runtime; a static import is.',
        );
      }
      module = await this._fetch(resolveSpecifier(specifier, base));
      await this._link(module);
    } catch (error) {
      // the runtime's parse or link error is the context's already
      throw isHostError(error) ? this._pageError(messageOf(error)) : error;
    }
    // Evaluated here, as an entry runs: with the timeout, and once, however
    // many `import()`s are waiting on it — the runtime handed two of them a
    // module still evaluating, and its bindings before they were set.
    // What its code throws is the page's, and goes back to the page as is.
    let evaluated = this._evaluated.get(module);
    // One a module that imports it evaluated, as its dependency, is
    // evaluated already: run again it would be refused, and one still
    // evaluating is waiting on this very `import()` where it is the module
    // a top-level `await` is in.
    if (!evaluated && module.status !== 'linked') return module;
    if (!evaluated) {
      this._depth += 1;
      try {
        evaluated = module.evaluate({ timeout: this._options.timeout });
      } catch (error) {
        evaluated = Promise.reject(error);
      } finally {
        this._depth -= 1;
        if (!this._depth && !this._disposed) this._options.settled();
      }
      this._evaluated.set(module, evaluated);
    }
    try {
      await evaluated;
    } catch (error) {
      if (ownData(error, 'code') === TIMEOUT) {
        this._options.onTimeout();
        throw this._pageError(`The module ${module.identifier} ran too long.`);
      }
      throw isHostError(error) ? this._pageError(messageOf(error)) : error;
    }
    return module;
  }

  /** A module linked, once. */
  private _link(module: PageModule): Promise<void> {
    let linked = this._linked.get(module);
    if (!linked) {
      // noted before linking starts, so what it imports finds it
      // (`_linker`): the runtime asks for those from inside `link()`
      let start!: () => void;
      linked = new Promise<void>((resolve, reject) => {
        start = () => module.link(this._linker).then(resolve, reject);
      });
      this._linked.set(module, linked);
      start();
    }
    return linked;
  }

  /** A `TypeError` of the page's own, with nothing of the host's in its
   *  `stack`: made by the host, it would name the host's frames and files. */
  private _pageError(message: string): object {
    const error = new this._TypeError(message);
    Object.defineProperty(error, 'stack', {
      value: `TypeError: ${message}`,
      writable: true,
      configurable: true,
    });
    return error;
  }

  private readonly _drainLater = (): void => {
    setTimeout(() => {
      if (!this._disposed) this.call('__drain', null);
    }, 0);
  };

  /** A linked module evaluated as an entry is run: with the timeout, and
   *  the tree's changes handed over once it is done. What it throws is the
   *  page's, read only in the page (`__fault`, over `__thrown`). */
  private _evaluate(module: PageModule): boolean {
    // one an `import()` has evaluated already ran then
    if (this._evaluated.has(module)) return true;
    this._depth += 1;
    let done: Promise<void>;
    try {
      done = module.evaluate({ timeout: this._options.timeout });
    } catch (error) {
      this._fault(error);
      return false;
    } finally {
      this._depth -= 1;
      if (!this._depth && !this._disposed) this._options.settled();
    }
    this._evaluated.set(module, done);
    done.then(
      () => {
        if (!this._disposed) this._options.settled();
      },
      (error) => this._fault(error),
    );
    return true;
  }

  /**
   * What a module threw, or the timeout that stopped it, or what failed to
   * fetch, parse or link: reported in the page, as what a classic script
   * throws is. An error of the host's — a fetch's, the runtime's timeout on
   * a runtime that makes it in the host — is told apart without running
   * anything of the page's, made the page's own, and only then handed in.
   * Anything else is the page's, read only by the page, under the timeout:
   * its thrown object may be a proxy, or have getters that run its code.
   */
  private _fault(error: unknown): void {
    if (this._broken || this._disposed) return;
    if (isHostError(error)) {
      if ((error as { code?: unknown }).code === TIMEOUT) {
        this._options.onTimeout();
        return;
      }
      error = this._pageError(messageOf(error));
    }
    try {
      (this._context as Record<string, unknown>).__thrown = error;
    } catch {
      return;
    }
    if (this.call('__fault', null) === 'timeout') this._options.onTimeout();
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
    this._modules.clear();
    ENGINES.delete(this._promises);
  }
}

/** The code of the error a `vm` timeout throws. */
const TIMEOUT = 'ERR_SCRIPT_EXECUTION_TIMEOUT';

/**
 * Whether a value is an error of the host's realm, asked without running
 * anything of the page's: its prototype chain read one link at a time, a
 * proxy anywhere in it the page's, whose `getPrototypeOf` would run.
 */
function isHostError(value: unknown): value is Error {
  let at: unknown = value;
  while (at !== null && (typeof at === 'object' || typeof at === 'function')) {
    if (types.isProxy(at)) return false;
    if (at === Error.prototype) return true;
    at = Object.getPrototypeOf(at);
  }
  return false;
}

/** A value's own data property, read without running anything of the
 *  page's: undefined from a proxy, or where the property is an accessor. */
function ownData(value: unknown, key: string): unknown {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return undefined;
  }
  if (types.isProxy(value)) return undefined;
  const found = Object.getOwnPropertyDescriptor(value, key);
  return found && 'value' in found ? found.value : undefined;
}

/** The message of an error of the host's own (`isHostError`), which the
 *  page's code cannot have changed. */
function messageOf(error: Error): string {
  return `${error.name}: ${error.message}`;
}
