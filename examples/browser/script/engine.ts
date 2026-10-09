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
  /** What `import()` hands a page: its exports. */
  readonly namespace: object;
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
    ): Promise<object>;
  },
) => PageModule;
const SourceTextModule = (vm as unknown as { SourceTextModule?: ModuleClass })
  .SourceTextModule;

/**
 * Whether an `import()` in a context hands the page a promise of its own
 * realm, asked once of a throwaway context of each kind the engine makes:
 * Node 21 to 23 make it in the host's, whatever the callback answers, and
 * its `constructor.constructor` is the host's `Function` —
 * `import('x').constructor.constructor('return process')()` was the host's
 * `process` there. Node 20, 24 and later, and Bun make it the page's.
 */
function importStaysInPage(): boolean {
  const constant = vm.constants?.DONT_CONTEXTIFY;
  const globals: object[] = [Object.create(null)];
  if (constant !== undefined) globals.push(constant as unknown as object);
  try {
    return globals.every((global) => {
      const context = vm.createContext(global as never);
      const made = new vm.Script('import("probe:")', {
        // answered never, so that nothing is left to reject
        importModuleDynamically: (() => new Promise(() => {})) as never,
      }).runInContext(context) as object;
      return (
        Object.getPrototypeOf(made) ===
        new vm.Script('Promise.prototype').runInContext(context)
      );
    });
  } catch {
    return false;
  }
}

/**
 * Whether this runtime can keep a page's `import()` in its context: Bun,
 * and Node with `--experimental-vm-modules` — what `vm.SourceTextModule`
 * being there says on both, since the flag that makes the class is the one
 * that makes Node call a script's `importModuleDynamically` at all — where
 * the promise an `import()` hands the page is the page's own
 * (`importStaysInPage`). Where it is false, no engine is made, and a page
 * is a browser's with scripts off. The browser starts every pane with the
 * flag (`PANE_FLAGS`), and its own process from `npm run
 * examples:browser`.
 */
export const SCRIPTS_CONTAINED = !!SourceTextModule && importStaysInPage();

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

/**
 * A promise the context's own queue settles, awaited by entering the
 * context until it has. A module's `evaluate()` answers one: on Node 20, and
 * on 22 before its later releases, it settles only as the context's queue
 * runs, which under `microtaskMode: 'afterEvaluate'` runs only as the host
 * enters the context — and what would enter it next was the `import()` that
 * waited on it, so every `import()` waited for ever. A later Node settles it
 * from outside, and the first turn finds it settled. `enter` answers false
 * where there is nothing to enter any more.
 */
async function settledIn<T>(
  promise: Promise<T>,
  enter: () => boolean,
): Promise<T> {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  promise.then(mark, mark);
  for (let wait = 0; ; wait = Math.min(50, wait ? wait * 2 : 1)) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (settled || !enter()) return promise;
  }
}

/** A specifier as a URL where it is one (HTML 8.1.5.5, "resolve a
 *  URL-like module specifier"): one that starts with `/`, `./` or `../`,
 *  against `base`, or a whole URL; null for a bare one, `lodash`. */
function urlLike(specifier: string, base: string): string | null {
  if (/^(?:\/|\.\/|\.\.\/)/.test(specifier)) {
    try {
      return new URL(specifier, base).href;
    } catch {
      return null;
    }
  }
  try {
    return new URL(specifier).href;
  } catch {
    return null;
  }
}

/** An import map's specifier map, its keys as specifiers match them and
 *  its values URLs, the longest key first (HTML 8.1.5.6). */
type SpecifierMap = [string, string | null][];

/** A document's import map: the top-level imports, and the scopes, the
 *  most specific first. */
interface ImportMap {
  imports: SpecifierMap;
  scopes: [string, SpecifierMap][];
}

/** A specifier map as an import map's JSON writes it, normalized against
 *  the map's base URL (HTML 8.1.5.6, "sort and normalize a specifier
 *  map"): a value that is no URL maps its key to nothing. */
function specifierMap(raw: unknown, base: string): SpecifierMap {
  if (!raw || typeof raw !== 'object') return [];
  const out: SpecifierMap = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key) continue;
    const normalized = urlLike(key, base) ?? key;
    const address = typeof value === 'string' ? urlLike(value, base) : null;
    // a key ending in `/` maps a prefix, and only to one
    out.push([
      normalized,
      key.endsWith('/') && address && !address.endsWith('/') ? null : address,
    ]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

/** What a specifier map says a specifier is: its exact key's address, or
 *  the address of the longest prefix key it starts with, with the rest
 *  of it after; undefined where no key matches, null where one maps it to
 *  nothing (HTML 8.1.5.5, "resolve an imports match"). */
function mapped(
  specifier: string,
  url: string | null,
  map: SpecifierMap,
): string | null | undefined {
  for (const [key, address] of map) {
    if (key === specifier) return address;
    if (
      key.endsWith('/') &&
      specifier.startsWith(key) &&
      (url === null || !/^[a-z][a-z0-9+.-]*:/i.test(key) || url.startsWith(key))
    ) {
      if (address === null) return null;
      try {
        const out = new URL(specifier.slice(key.length), address).href;
        return out.startsWith(address) ? out : null;
      } catch {
        return null;
      }
    }
  }
  return undefined;
}

/**
 * A module specifier as a URL (HTML 8.1.5.5, "resolve a module
 * specifier"): through the document's import map where it has one — the
 * scopes the importing module is under first, the most specific first,
 * and then the top-level imports — and where it says nothing, one that is
 * a URL already. A bare one no map names is a `TypeError`.
 */
function resolveSpecifier(
  specifier: string,
  base: string,
  map: ImportMap | null = null,
): string {
  const url = urlLike(specifier, base);
  const normalized = url ?? specifier;
  if (map) {
    for (const [scope, imports] of map.scopes) {
      if (scope === base || (scope.endsWith('/') && base.startsWith(scope))) {
        const found = mapped(normalized, url, imports);
        if (found === null) break;
        if (found !== undefined) return found;
      }
    }
    const found = mapped(normalized, url, map.imports);
    if (found === null) {
      throw new TypeError(`The import map blocks "${specifier}".`);
    }
    if (found !== undefined) return found;
  }
  if (url !== null) return url;
  throw new TypeError(
    `Failed to resolve module specifier "${specifier}". Relative references must start with either "/", "./", or "../".`,
  );
}
/** The engines alive in this process, by their context's
 *  `Promise.prototype`: what tells a page's unhandled rejection from the
 *  host's (`watchRejections`). */
const ENGINES = new Map<object, ScriptEngine>();

/** The listeners for `unhandledRejection` there were before the engine's
 *  (`watchRejections`), which hear every rejection that is not a page's. */
type RejectionListener = (reason: unknown, promise: Promise<unknown>) => void;
const LISTENED_BEFORE: RejectionListener[] = [];

/**
 * A page's promise rejected with nothing to catch it is the page's to
 * report, as a browser reports one, and not the process's to die of: in a
 * `vm` context with its own microtask queue it reaches `process` as any
 * other would, and its default is to end the process — the tab. Which
 * context a promise is of is its prototype's, read without running anything
 * of the page's: a promise is no proxy. Anything else goes to the listeners
 * that were there before, or is thrown again where there were none, as if
 * this had not listened.
 */
const onRejection: RejectionListener = (reason, promise) => {
  const engine = ENGINES.get(Object.getPrototypeOf(promise) as object);
  if (engine) {
    engine.rejected(reason, promise);
    return;
  }
  if (!LISTENED_BEFORE.length) throw reason;
  for (const listener of LISTENED_BEFORE) {
    listener.call(process, reason, promise);
  }
};

/**
 * Listen, and alone: the listeners already there are taken off and hear
 * from this one. Every listener hears every rejection, and core's pane
 * registers one before it loads the page's module that ends the process at
 * the first — so a page's rejection reached it ahead of this one, and closed
 * the tab: x.com's refused `import()`, react.dev's Sandpack reaching for a
 * frame's `location`. A listener added since is taken over at the next
 * engine.
 */
function watchRejections(): void {
  for (const listener of process.listeners('unhandledRejection')) {
    if (listener === onRejection) continue;
    process.off('unhandledRejection', listener);
    LISTENED_BEFORE.push(listener as RejectionListener);
  }
  if (!process.listeners('unhandledRejection').includes(onRejection)) {
    process.on('unhandledRejection', onRejection);
  }
}

const CONTEXT_OPTIONS: vm.CreateContextOptions = {
  name: 'page',
  microtaskMode: 'afterEvaluate',
  // a page's own `eval` and `new Function` are the context's, and an
  // `on…` attribute is compiled with one. WebAssembly is compiled in it
  // too — yoga's layout in the react-x11 playground is — and its streaming
  // compile is the facade's (`installDom`), since the runtime's is the
  // host's. Node's timeout stops a module that runs away as it stops a
  // script; Bun's does not, and the pane's watchdog ends that tab.
  codeGeneration: { strings: true, wasm: true },
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
  /** The document's import map (`importMap`), where it has one. */
  private _importMap: ImportMap | null = null;
  /** The link under way, which the next waits for (`_link`). */
  private _linking: Promise<void> = Promise.resolve();
  private readonly _evaluated = new WeakMap<PageModule, Promise<void>>();
  /** The entries, compiled for this context, so that an `import()` in what
   *  they run is this document's (`_dynamic`). */
  private readonly _entries = new Map<string, vm.Script>();
  /** The callback every script compiled into the context has, and the
   *  context itself: a page's `import()`, resolved against the document. */
  private readonly _importer: (specifier: string) => Promise<object>;
  /** The context's own `TypeError`, taken before any page code runs: what a
   *  failed `import()` rejects with is the page's, never a host error, whose
   *  `constructor.constructor` is the host's `Function`. */
  private readonly _TypeError: new (message: string) => object;
  /** The context's global, the page's window (`global`). */
  private readonly _global: object;

  constructor(
    bridge: Bridge,
    private readonly _options: EngineOptions,
  ) {
    if (!SCRIPTS_CONTAINED) {
      throw new Error(
        "A page's scripts are not run where its import() would reach the host: run Node 20, or 24 or later, with --experimental-vm-modules, or Bun.",
      );
    }
    this._importer = (specifier) =>
      this._imported(this._dynamic(specifier, this._options.base?.() ?? ''));
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
    this._global = run('globalThis') as object;
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
        this._imported(this._dynamic(specifier, referrer.identifier ?? url)),
    });
  }

  /**
   * An `import()`'s answer, with the context entered once it is settled:
   * the page's promise settles in the context's own queue, which runs only
   * as the host enters it (`microtaskMode`). A module's `import()` as much
   * as a classic script's — on Node 22 before its later releases, a
   * module's top-level `await` of one went on only where something else
   * entered the context after it.
   */
  private _imported(done: Promise<object>): Promise<object> {
    done.then(this._drainLater, this._drainLater);
    return done;
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
    return this._fetch(
      resolveSpecifier(specifier, referencing.identifier, this._importMap),
    );
  };

  /**
   * `import()`: the module, fetched, linked and evaluated, and its namespace
   * for the runtime to hand the page. Node takes a module or its namespace;
   * Bun 1.4 hands the page whatever this answers, and made a module answered
   * whole an object with none of its exports, so every `import()` there was
   * refused until it was answered with the namespace. What failed is the
   * context's own `TypeError`, with the message read here from an error of
   * ours.
   */
  private async _dynamic(specifier: string, base: string): Promise<object> {
    let module: PageModule;
    try {
      module = await this._fetch(
        resolveSpecifier(specifier, base, this._importMap),
      );
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
    if (!evaluated && module.status !== 'linked') return module.namespace;
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
      await settledIn(evaluated, () => {
        if (this._disposed || this._broken) return false;
        this.call('__drain', null);
        return true;
      });
    } catch (error) {
      if (ownData(error, 'code') === TIMEOUT) {
        this._options.onTimeout();
        throw this._pageError(`The module ${module.identifier} ran too long.`);
      }
      throw isHostError(error) ? this._pageError(messageOf(error)) : error;
    }
    return module.namespace;
  }

  /**
   * A module linked, once, and one graph at a time. Two graphs linked at
   * once that share a module — two `import()`s of pages that both import
   * the same helper — had the runtime hand the second a module the first
   * was still linking, and refuse it as one "that is not linked". One at a
   * time, the later graph finds what they share linked already, and a
   * cycle inside one graph is the runtime's own to link.
   */
  private _link(module: PageModule): Promise<void> {
    let linked = this._linked.get(module);
    if (!linked) {
      linked = this._linking.then(() =>
        // linked already, as a module an earlier graph imports
        module.status === 'unlinked' ? module.link(this._linker) : undefined,
      );
      this._linked.set(module, linked);
      this._linking = linked.catch(() => {});
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

  /**
   * The context entered once the host has settled an `import()`, so that
   * the page's promise and what waits on it run. More than once: the
   * runtime hands the namespace over in steps that go through the
   * context's own queue, which runs only as the host enters it, and one
   * entry ran the first step alone — a module's top-level `await` of a
   * module evaluated already went on only when a timer of the page's
   * happened to enter the context after it.
   */
  private readonly _drainLater = (): void => {
    let turns = 0;
    const drain = (): void => {
      if (this._disposed) return;
      this.call('__drain', null);
      if ((turns += 1) < DRAIN_TURNS) setTimeout(drain, 0);
    };
    setTimeout(drain, 0);
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

  /**
   * A `<script type="importmap">`'s JSON (HTML 8.1.5.6), its URLs against
   * `base`: what a bare specifier, `react`, resolves to from then on. A
   * second map's imports go under the first's, which keeps every key it
   * has, as HTML merges them; one that is not JSON is reported and left.
   */
  importMap(json: string, base: string): void {
    let raw: { imports?: unknown; scopes?: unknown };
    try {
      raw = JSON.parse(json) as typeof raw;
    } catch {
      this._options.log(
        'error',
        'An import map that is not JSON was left out.',
      );
      return;
    }
    const imports = specifierMap(raw?.imports, base);
    const scopes: [string, SpecifierMap][] = [];
    if (raw?.scopes && typeof raw.scopes === 'object') {
      for (const [scope, map] of Object.entries(raw.scopes)) {
        const prefix = urlLike(scope, base);
        if (prefix) scopes.push([prefix, specifierMap(map, base)]);
      }
    }
    scopes.sort((a, b) => b[0].length - a[0].length);
    const was = this._importMap;
    if (!was) {
      this._importMap = { imports, scopes };
      return;
    }
    const kept = new Set(was.imports.map(([key]) => key));
    was.imports.push(...imports.filter(([key]) => !kept.has(key)));
    was.imports.sort((a, b) => b[0].length - a[0].length);
    was.scopes.push(...scopes);
    was.scopes.sort((a, b) => b[0].length - a[0].length);
  }

  /** A page's classic script, run in the global scope, as `currentScript`
   *  the element with `script`'s id (0 for none). Whether it ran to its
   *  end; what it threw is reported in the page. */
  exec(code: string, url: string, script: number): boolean {
    const ran = this.call('__exec', [code, url, script]) === true;
    // after the microtasks it queued, which ran as the entry ended
    this.call('__ran', null);
    return ran;
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

  /**
   * This realm's global, for another page realm of the same page to reach
   * it as a browser's same-origin frames reach each other's windows
   * (`link`). A page's object, never handed to anything of the host's.
   */
  get global(): object {
    return this._global;
  }

  /**
   * Join this realm and another page realm, a frame's and the page it is
   * in: each handed the other's global through a data slot, and told
   * through an entry (`__linkFrame`, `__linkParent`) to make the window
   * that stands for it there. Both are page realms: what one reaches of the
   * other is what a same-origin frame reaches of its parent. Nothing of the
   * host's is handed to either.
   */
  link(frame: ScriptEngine, frameId: number): void {
    if (this._broken || this._disposed) return;
    const into = (engine: ScriptEngine, value: object): void => {
      (engine._context as Record<string, unknown>).__handed = value;
    };
    into(this, frame._global);
    this.call('__linkFrame', [frameId]);
    into(frame, this._global);
    frame.call('__linkParent', [frameId]);
  }

  /** A frame's realm is gone, or has gone on to another document: the
   *  page's window for it stands for nothing of it any more. */
  unlink(frameId: number): void {
    this.call('__unlinkFrame', [frameId]);
  }

  /** A promise of the page's rejected and nothing caught it: told in the
   *  page, as `unhandledrejection`, and reported there with its reason, as
   *  a browser reports one — read by the page, under the timeout, since the
   *  reason is the page's object (`__thrown`). */
  rejected(reason: unknown, promise: unknown): void {
    if (this._broken || this._disposed) return;
    try {
      (this._context as Record<string, unknown>).__thrown = reason;
      (this._context as Record<string, unknown>).__promise = promise;
    } catch {
      return;
    }
    this.call('__rejected', null);
  }

  dispose(): void {
    this._disposed = true;
    this._modules.clear();
    ENGINES.delete(this._promises);
  }
}

/** How many turns of the host's the context is entered on after an
 *  `import()` settles (`_drainLater`). */
const DRAIN_TURNS = 4;

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
 *  page's code cannot have changed, for the `TypeError` the page is handed:
 *  with its kind where that is another, and without where it is the same,
 *  which a page reported as `TypeError: TypeError: …`. */
function messageOf(error: Error): string {
  return error.name === 'TypeError'
    ? error.message
    : `${error.name}: ${error.message}`;
}
