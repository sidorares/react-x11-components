// A page's worklets as its page sees them (HTML 8.1.5, Worklets): `Worklet`
// and `AudioWorklet`, `CSS.paintWorklet`, and what `addModule` answers.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing.
//
// What a module of a worklet's does is the host's (`worklet-host.ts`): its
// graph is fetched there, as the document's, and run in a global scope of
// its own that no page code reaches. Here a worklet is a number the host
// knows its scope by, and `addModule` a promise the host settles a task
// after the graph has run or failed (`added`), with the names its scope has
// registered since, which an `AudioWorkletNode` is made by.

declare const URL: new (url: string, base?: string) => { href: string };

/** What `installDom` hands this. */
export interface WorkletDeps {
  /** A bridge call. */
  host(op: string, a?: unknown): unknown;
  DOMException: unknown;
  /** The document's base URL, which a module's address is parsed against. */
  base(): string;
}

export function installWorklets(deps: WorkletDeps) {
  'use strict';
  type Any = any;
  const { host } = deps;
  const DOMException = deps.DOMException as Any;
  const P: Any = Promise;
  const TOKEN = Object.freeze(Object.create(null));

  /** Each worklet's number, kind and what its scope has registered. */
  const SCOPES = new WeakMap<object, Any>();
  /** The `addModule`s the host has yet to settle, by their number. */
  const pending = new Map<number, Any>();
  let scopes = 0;
  let asks = 0;

  const CREDENTIALS = ['omit', 'same-origin', 'include'];

  class Worklet {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw new TypeError('Illegal constructor');
    }
    addModule(moduleURL: Any, options: Any = undefined): Promise<void> {
      const scope = SCOPES.get(this);
      if (!scope) return P.reject(new TypeError('Illegal invocation'));
      if (arguments.length === 0) {
        return P.reject(
          new TypeError(
            "Failed to execute 'addModule' on 'Worklet': 1 argument required, but only 0 present.",
          ),
        );
      }
      let url: string;
      try {
        url = new URL(String(moduleURL), deps.base()).href;
      } catch {
        return P.reject(
          new DOMException(
            `Failed to execute 'addModule' on 'Worklet': The URL '${String(moduleURL)}' is invalid.`,
            'SyntaxError',
          ),
        );
      }
      const given =
        options === undefined || options === null
          ? undefined
          : options.credentials;
      const credentials = given === undefined ? 'same-origin' : String(given);
      if (!CREDENTIALS.includes(credentials)) {
        return P.reject(
          new TypeError(
            `Failed to execute 'addModule' on 'Worklet': The provided value '${credentials}' is not a valid enum value of type RequestCredentials.`,
          ),
        );
      }
      const ask = (asks += 1);
      return new P((resolve: Any, reject: Any) => {
        pending.set(ask, { resolve, reject, scope });
        host(
          'worklet',
          JSON.stringify({
            ask,
            scope: scope.id,
            kind: scope.kind,
            url,
            credentials,
            sampleRate: scope.sampleRate,
          }),
        );
      });
    }
  }
  Object.defineProperty(Worklet.prototype, Symbol.toStringTag, {
    value: 'Worklet',
    configurable: true,
  });
  class AudioWorklet extends Worklet {}
  Object.defineProperty(AudioWorklet.prototype, Symbol.toStringTag, {
    value: 'AudioWorklet',
    configurable: true,
  });

  /** A worklet of a kind, with a scope of its own. */
  const make = (kind: 'audio' | 'paint', sampleRate = 0): Any => {
    const worklet =
      kind === 'audio' ? new AudioWorklet(TOKEN) : new Worklet(TOKEN);
    SCOPES.set(worklet, {
      id: (scopes += 1),
      kind,
      sampleRate,
      names: new Set<string>(),
    });
    return worklet;
  };

  /** What the host says of an `addModule` (`__workletAdded`). */
  const added = (ask: number, status: string, names: string): void => {
    const waiting = pending.get(ask);
    if (!waiting) return;
    pending.delete(ask);
    try {
      for (const name of JSON.parse(names))
        waiting.scope.names.add(String(name));
    } catch {}
    if (status === 'ok') waiting.resolve(undefined);
    else if (status === 'syntax') {
      waiting.reject(new SyntaxError("A worklet's module did not compile."));
    } else {
      waiting.reject(
        new DOMException(
          "Failed to execute 'addModule' on 'Worklet': The module did not load.",
          'AbortError',
        ),
      );
    }
  };

  /** Whether a worklet's scope has registered a name. */
  const registered = (worklet: Any, name: string): boolean =>
    !!SCOPES.get(worklet)?.names.has(name);

  return {
    interfaces: { Worklet, AudioWorklet },
    make,
    added,
    registered,
  };
}
