// A page's worklets, on the host: each one a global scope of its own, a
// context with the few names its kind of worklet has, into which
// `addModule` fetches a module graph and runs it (HTML 8.1.5, Worklets 1).
//
// What a worklet is for is out of reach here: an audio worklet's processors
// would run on a render thread that a silent Web Audio has none of
// (`webaudio.ts`), and a paint worklet's painters for a `paint()` image the
// cascade reads none of. What is here is what a page can see: the module
// graph fetched as the document's for the worklet's destination, held to its
// policies, its insecure requests upgraded, its `Referer` the document's;
// evaluated where nothing of the page's is, so what it registers is known;
// and the promise `addModule` answered settled as HTML settles it.
//
// Three things are load-bearing.
//
//   - **Nothing of the host's is handed to the context.** Every function a
//     worklet's code can reach is made in its context, from source text, so
//     none has the host's `Function` for its `constructor.constructor`; what
//     it registered is read back as a string.
//   - **Its string compilation is what the document's policies allow**: a
//     context's `codeGeneration` refuses `eval` and `Function` natively, and
//     WebAssembly's compile, where a policy without `'unsafe-eval'` or
//     `'wasm-unsafe-eval'` would (CSP 3, 4.4, which a worklet's global is
//     held to as its document's owner set says).
//   - **`import()` is refused**, as a worklet's is (HTML, "HostLoadImported
//     Module": a worklet's global scope has none), with the context's own
//     `TypeError`.

import type { VmContext, VmModule, VmScript } from './platform.js';
import { nodeModule } from './platform.js';

declare const URL: new (url: string, base?: string) => { href: string };

const vm = await nodeModule<VmModule>('vm');

/** A module of a worklet's, as the runtime has it (`vm.SourceTextModule`). */
interface WorkletModule {
  readonly identifier: string;
  readonly status: string;
  link(
    linker: (
      specifier: string,
      referencing: WorkletModule,
    ) => Promise<WorkletModule>,
  ): Promise<void>;
  evaluate(options?: { timeout?: number }): Promise<void>;
}
type ModuleClass = new (
  source: string,
  options: {
    context: VmContext;
    identifier: string;
    importModuleDynamically(): Promise<never>;
  },
) => WorkletModule;
const SourceTextModule = vm.SourceTextModule as ModuleClass | undefined;

/** The kinds of worklet a page has: an audio worklet's global and a paint
 *  worklet's (Web Audio 1, 1.32; CSS Painting API 1, 4). */
export type WorkletKind = 'audio' | 'paint';

/** What a worklet's global scope is given, as source text run in it. */
function scopeSource(kind: WorkletKind, sampleRate: number): string {
  return `(() => {
    'use strict';
    const names = [];
    const define = (name, value) => Object.defineProperty(globalThis, name, {
      value, writable: true, configurable: true, enumerable: false });
    const register = (what) => function (name, definition) {
      name = String(name);
      if (name === '') throw new TypeError('The name of a ' + what + ' is empty.');
      if (typeof definition !== 'function') {
        throw new TypeError('A ' + what + ' is a class.');
      }
      if (names.includes(name)) {
        throw new TypeError('A ' + what + ' named ' + name + ' is registered already.');
      }
      names.push(name);
    };
    Object.defineProperty(globalThis, '__registered', {
      value: () => JSON.stringify(names) });
    const nothing = () => {};
    define('console', { log: nothing, info: nothing, warn: nothing, error: nothing,
      debug: nothing, trace: nothing, assert: nothing });
    ${
      kind === 'audio'
        ? `define('registerProcessor', register('processor'));
    define('AudioWorkletProcessor', class AudioWorkletProcessor {});
    define('sampleRate', ${Number(sampleRate) || 0});
    define('currentFrame', 0);
    define('currentTime', 0);`
        : `define('registerPaint', register('painter'));
    define('devicePixelRatio', 1);`
    }
  })()`;
}

/** What the host hands the worklets. */
export interface WorkletSeams {
  /** A module's source as the document fetches it for a worklet, with the
   *  worklet's destination and its credentials mode, held to the document's
   *  policies; null where it was refused or failed. */
  fetch(
    url: string,
    destination: string,
    credentials: string,
  ): Promise<string | null>;
  /** Whether the document's policies let a string be compiled, and
   *  WebAssembly. */
  compiles(): { strings: boolean; wasm: boolean };
}

/** How `addModule` came out: `ok` and the names now registered, `abort`
 *  where a module of its graph did not come (an `AbortError`), or the
 *  name of the error a module of it could not be compiled with. */
export interface WorkletAdded {
  status: 'ok' | 'abort' | 'syntax';
  names: string[];
}

interface Scope {
  context: VmContext;
  /** What an `import()` in it is answered with. */
  refuse(): Promise<never>;
  /** Each module by its URL, which a second `addModule` of it finds. */
  modules: Map<string, Promise<WorkletModule>>;
}

/** A document's worklets, by the number its page gave each. */
export class PageWorklets {
  private readonly _scopes = new Map<number, Scope>();

  constructor(private readonly _seams: WorkletSeams) {}

  /** A worklet's scope, made the first time it is asked for. */
  private _scope(id: number, kind: WorkletKind, sampleRate: number): Scope {
    let scope = this._scopes.get(id);
    if (!scope) {
      const { strings, wasm } = this._seams.compiles();
      // its global an object of no prototype, so `this.constructor` reaches
      // nothing of the host's (the engine's rule 1), and an `import()` in
      // code compiled with no callback of its own refused as one in a
      // module is (rule 5)
      let context: VmContext | null = null;
      const refuse = (): Promise<never> =>
        Promise.reject(
          new vm.Script(
            `new TypeError('A worklet cannot import().')`,
          ).runInContext(context!),
        );
      context = vm.createContext(Object.create(null), {
        name: `${kind} worklet`,
        codeGeneration: { strings, wasm },
        importModuleDynamically: refuse as never,
      });
      (
        new vm.Script(scopeSource(kind, sampleRate), {
          importModuleDynamically: refuse as never,
        }) as VmScript
      ).runInContext(context);
      scope = { context, modules: new Map(), refuse };
      this._scopes.set(id, scope);
    }
    return scope;
  }

  /** A module of a scope's graph, fetched and compiled once a URL. */
  private _module(
    scope: Scope,
    url: string,
    destination: string,
    credentials: string,
  ): Promise<WorkletModule> {
    let module = scope.modules.get(url);
    if (!module) {
      module = this._seams.fetch(url, destination, credentials).then((code) => {
        if (code === null) throw new WorkletFetchError(url);
        return new SourceTextModule!(code, {
          context: scope.context,
          identifier: url,
          importModuleDynamically: scope.refuse,
        });
      });
      // a module that did not come is asked for again by the next
      // `addModule`, as HTML's module map keeps none for it
      module.catch(() => {
        if (scope.modules.get(url) === module) scope.modules.delete(url);
      });
      scope.modules.set(url, module);
    }
    return module;
  }

  /**
   * `addModule` (HTML 8.1.5.2): the graph at `url` fetched into the
   * worklet's scope, linked and run. What its code throws as it runs is its
   * own, and leaves the module added; a module of the graph that did not
   * come is an `abort`, and one that does not compile a `syntax`.
   */
  async add(
    id: number,
    kind: WorkletKind,
    url: string,
    credentials: string,
    sampleRate = 0,
  ): Promise<WorkletAdded> {
    const scope = this._scope(id, kind, sampleRate);
    const destination = `${kind}worklet`;
    const names = (): string[] => {
      try {
        const read = (
          new vm.Script('__registered()', {
            importModuleDynamically: scope.refuse as never,
          }) as VmScript
        ).runInContext(scope.context);
        const list =
          typeof read === 'string' ? (JSON.parse(read) as unknown) : [];
        return Array.isArray(list) ? list.map(String) : [];
      } catch {
        return [];
      }
    };
    if (!SourceTextModule) return { status: 'abort', names: names() };
    let root: WorkletModule;
    try {
      root = await this._module(scope, url, destination, credentials);
      if (root.status === 'unlinked') {
        await root.link((specifier, referencing) => {
          let to: string;
          try {
            to = new URL(specifier, referencing.identifier).href;
          } catch {
            return Promise.reject(new WorkletFetchError(specifier));
          }
          return this._module(scope, to, destination, credentials);
        });
      }
    } catch (error) {
      return {
        status: error instanceof WorkletFetchError ? 'abort' : 'syntax',
        names: names(),
      };
    }
    try {
      if (root.status === 'linked') await root.evaluate({ timeout: 2000 });
    } catch {
      // what it threw is its global scope's to report, and the module is
      // added all the same
    }
    return { status: 'ok', names: names() };
  }

  /** The worklets are let go with their document. */
  dispose(): void {
    this._scopes.clear();
  }
}

/** A module of a worklet's graph that did not come. */
class WorkletFetchError extends Error {
  constructor(url: string) {
    super(`A worklet's module did not load: ${url}`);
  }
}
