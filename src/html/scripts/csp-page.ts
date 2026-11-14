// A document's Content Security Policy as its page sees it (CSP 3): the
// `SecurityPolicyViolationEvent` a violation is told with, fired where the
// host says (`csp-host.ts`), and the string compilation a policy without
// `'unsafe-eval'` refuses — `eval`, `Function`, a string handed to a timer —
// and the WebAssembly one without `'wasm-unsafe-eval'`.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing.
//
// What decides is never here. The page could replace anything this calls,
// so every question goes to the host (`csp` ops), which holds the policies
// and fires the event a task later whatever this answers. A guard is
// installed only once a policy says something of strings: until then
// `eval` is the realm's own, and a direct `eval` reads the scope it is in.

/** What `installDom` hands this. */
export interface CspDeps {
  Event: unknown;
  /** A bridge call. */
  host(op: string, a?: unknown, b?: unknown, c?: unknown): unknown;
  /** Dispatches an event the user agent fires. */
  fire(target: unknown, event: unknown): void;
  /** The global the guards go on. */
  global: unknown;
  /** The realm's own `eval` and `Function`, taken before any page code. */
  nativeEval: unknown;
  nativeFunction: unknown;
  /** Trusted Types (`trusted-types.ts`): a TrustedScript's string, or
   *  undefined for anything else, and a string as the default policy makes
   *  it where the document requires Trusted Types, throwing where none
   *  does. */
  trustedScript?(value: unknown): string | undefined;
  trustedComply?(value: unknown, sink: string): string;
  trustedRequired?(): boolean;
}

export function installCsp(deps: CspDeps) {
  'use strict';
  type Any = any;
  const { host, fire } = deps;
  const Event = deps.Event as Any;
  const G = deps.global as Any;
  const nativeEval = deps.nativeEval as Any;
  const NativeFunction = deps.nativeFunction as Any;
  const usv = (v: Any): string => String(v);

  const DISPOSITIONS = ['enforce', 'report'];
  /** The events made here, which an attribute's getter is asked of: one
   *  read off another object is a `TypeError`, as a platform object's is
   *  (Web IDL 3.7.6). */
  const MADE = new WeakSet<object>();

  /** `securitypolicyviolation` (CSP 3, 5.?): what was refused, by which of
   *  the document's policies, and where. */
  class SecurityPolicyViolationEvent extends Event {
    _documentURI: string;
    _referrer: string;
    _blockedURI: string;
    _effectiveDirective: string;
    _violatedDirective: string;
    _originalPolicy: string;
    _sourceFile: string;
    _sample: string;
    _disposition: string;
    _statusCode: number;
    _lineNumber: number;
    _columnNumber: number;
    constructor(type: string, init: Any = {}) {
      if (arguments.length === 0) {
        throw new TypeError(
          "Failed to construct 'SecurityPolicyViolationEvent': 1 argument required, but only 0 present.",
        );
      }
      super(type, init);
      const d = init ?? {};
      const disposition =
        d.disposition === undefined ? 'enforce' : String(d.disposition);
      if (!DISPOSITIONS.includes(disposition)) {
        throw new TypeError(
          `Failed to construct 'SecurityPolicyViolationEvent': The provided value '${disposition}' is not a valid enum value of type SecurityPolicyViolationEventDisposition.`,
        );
      }
      this._documentURI = d.documentURI === undefined ? '' : usv(d.documentURI);
      this._referrer = d.referrer === undefined ? '' : usv(d.referrer);
      this._blockedURI = d.blockedURI === undefined ? '' : usv(d.blockedURI);
      this._effectiveDirective =
        d.effectiveDirective === undefined ? '' : String(d.effectiveDirective);
      this._violatedDirective =
        d.violatedDirective === undefined ? '' : String(d.violatedDirective);
      this._originalPolicy =
        d.originalPolicy === undefined ? '' : String(d.originalPolicy);
      this._sourceFile = d.sourceFile === undefined ? '' : usv(d.sourceFile);
      this._sample = d.sample === undefined ? '' : String(d.sample);
      this._disposition = disposition;
      this._statusCode = (Number(d.statusCode) || 0) & 0xffff;
      this._lineNumber = Number(d.lineNumber) >>> 0;
      this._columnNumber = Number(d.columnNumber) >>> 0;
      MADE.add(this);
    }
    get documentURI(): string {
      return this._documentURI;
    }
    get referrer(): string {
      return this._referrer;
    }
    get blockedURI(): string {
      return this._blockedURI;
    }
    get effectiveDirective(): string {
      return this._effectiveDirective;
    }
    get violatedDirective(): string {
      return this._violatedDirective;
    }
    get originalPolicy(): string {
      return this._originalPolicy;
    }
    get sourceFile(): string {
      return this._sourceFile;
    }
    get sample(): string {
      return this._sample;
    }
    get disposition(): string {
      return this._disposition;
    }
    get statusCode(): number {
      return this._statusCode;
    }
    get lineNumber(): number {
      return this._lineNumber;
    }
    get columnNumber(): number {
      return this._columnNumber;
    }
  }
  for (const name of [
    'documentURI',
    'referrer',
    'blockedURI',
    'effectiveDirective',
    'violatedDirective',
    'originalPolicy',
    'sourceFile',
    'sample',
    'disposition',
    'statusCode',
    'lineNumber',
    'columnNumber',
  ]) {
    const read = (
      Object.getOwnPropertyDescriptor(
        SecurityPolicyViolationEvent.prototype,
        name,
      ) as Any
    ).get;
    const get = {
      [name](this: Any): Any {
        if (!MADE.has(this)) throw new TypeError('Illegal invocation');
        return read.call(this);
      },
    }[name];
    Object.defineProperty(get, 'name', { value: `get ${name}` });
    Object.defineProperty(SecurityPolicyViolationEvent.prototype, name, {
      get,
      enumerable: true,
      configurable: true,
    });
  }
  Object.defineProperty(
    SecurityPolicyViolationEvent.prototype,
    Symbol.toStringTag,
    { value: 'SecurityPolicyViolationEvent', configurable: true },
  );

  /** A violation the host tells, fired at what it names (CSP 3, 5.3,
   *  "Report a violation"): bubbling and composed, so a listener on the
   *  document hears one fired at an element in a shadow tree. */
  const violation = (json: string, target: Any): void => {
    let v: Any;
    try {
      v = JSON.parse(json);
    } catch {
      return;
    }
    const ev = new SecurityPolicyViolationEvent('securitypolicyviolation', {
      ...v,
      bubbles: true,
      composed: true,
    });
    fire(target, ev);
  };

  // --- string compilation -----------------------------------------------------

  /** Whether the host lets a string be compiled, telling a violation where
   *  it does not, and an `EvalError` where an enforced policy refuses it. */
  const ensureCompiles = (source: string): void => {
    if (host('csp', 'eval', source) !== true) {
      throw new EvalError(
        "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive.",
      );
    }
  };

  let guarded = false;
  /** The guards put on, once a policy speaks of strings. */
  const guard = (): void => {
    if (guarded) return;
    guarded = true;
    const evalGuard = {
      eval(x: Any): Any {
        // a TrustedScript is the code it holds (Trusted Types, 4.8,
        // HostGetCodeForEval), and a string, where the document requires
        // Trusted Types, what the default policy makes of it, unchanged
        const held = deps.trustedScript?.(x);
        if (typeof x !== 'string' && held === undefined) return x;
        const source = held ?? x;
        if (held === undefined && deps.trustedRequired?.()) {
          let made: string;
          try {
            made = deps.trustedComply!(x, 'eval');
          } catch {
            throw new EvalError(
              "Refused to evaluate a string as JavaScript because this document requires 'TrustedScript' assignment.",
            );
          }
          if (made !== x) {
            throw new EvalError(
              'The default policy changed what eval was handed, which it may not.',
            );
          }
        }
        ensureCompiles(source);
        // indirect, as no call through a name but `eval` is direct
        return nativeEval(source);
      },
    }.eval;
    Object.defineProperty(G, 'eval', {
      value: evalGuard,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    const FunctionGuard = function Function(this: Any, ...args: Any[]): Any {
      const body = args.length ? String(args[args.length - 1]) : '';
      const params = args.slice(0, -1).map(String).join(',');
      ensureCompiles(`function anonymous(${params}\n) {\n${body}\n}`);
      return Reflect.construct(
        NativeFunction,
        args,
        new.target ?? NativeFunction,
      );
    } as Any;
    Object.defineProperty(FunctionGuard, 'prototype', {
      value: NativeFunction.prototype,
      writable: false,
    });
    Object.defineProperty(NativeFunction.prototype, 'constructor', {
      value: FunctionGuard,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(G, 'Function', {
      value: FunctionGuard,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };

  // --- WebAssembly ------------------------------------------------------------

  /** Whether the host lets WebAssembly be compiled (`'wasm-unsafe-eval'`),
   *  throwing a `CompileError` where an enforced policy refuses it. */
  const ensureWasm = (): void => {
    if (!wasmGuarded) return;
    if (host('csp', 'wasm') !== true) {
      const CompileError = G.WebAssembly?.CompileError ?? Error;
      throw new CompileError(
        "WebAssembly.Module(): Refused to compile or instantiate WebAssembly module because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive",
      );
    }
  };
  let wasmGuarded = false;
  const guardWasm = (): void => {
    if (wasmGuarded) return;
    wasmGuarded = true;
    const wasm = G.WebAssembly;
    const Module = wasm?.Module;
    if (typeof Module !== 'function') return;
    const ModuleGuard = function Module(this: Any, ...args: Any[]): Any {
      if (new.target === undefined) {
        throw new TypeError("WebAssembly.Module must be invoked with 'new'");
      }
      ensureWasm();
      return Reflect.construct(
        Module,
        args,
        new.target === ModuleGuard ? Module : new.target,
      );
    } as Any;
    Object.defineProperty(ModuleGuard, 'prototype', {
      value: Module.prototype,
      writable: false,
    });
    for (const key of Reflect.ownKeys(Module)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue;
      Object.defineProperty(
        ModuleGuard,
        key,
        Object.getOwnPropertyDescriptor(Module, key) as Any,
      );
    }
    Object.defineProperty(Module.prototype, 'constructor', {
      value: ModuleGuard,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(wasm, 'Module', {
      value: ModuleGuard,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };

  /** What the host says the policies now hold to: `p` where there is one,
   *  `e` where something speaks of `eval`, `w` of WebAssembly. */
  let policed = false;
  const policyChanged = (said: string): void => {
    if (said.includes('p')) policed = true;
    if (said.includes('e') || said.includes('t')) guard();
    if (said.includes('w')) guardWasm();
  };

  /** Whether a string may be compiled, telling a violation where it may
   *  not, without throwing: a timer's handler. Nothing is asked where no
   *  policy speaks of strings. */
  const compiles = (source: string): boolean =>
    !guarded || host('csp', 'eval', source) === true;

  return {
    interfaces: { SecurityPolicyViolationEvent },
    compiles,
    violation,
    policyChanged,
    ensureWasm,
    /** Whether the document has a policy, which an `on…` attribute is
     *  asked of. */
    get policed(): boolean {
      return policed;
    },
  };
}
