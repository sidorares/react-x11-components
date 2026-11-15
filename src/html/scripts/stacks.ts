// What a page's errors say of where they were made: the page's own frames,
// and none of the facade's or the host's.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine runs it in the context, through `Function.prototype.toString()`,
// before the facade and before any page code, so it closes over nothing.
//
// Every task a page runs is entered from the host — a timer, a listener, a
// script the parser met — and the runtime writes every frame on the stack
// into an error's `stack`: `Script.runInContext (node:vm:…)`, the engine's
// modules by their absolute paths, and the facade's frames between the
// page's. A page read the user's home directory and the install's layout
// off any error it made, and an error logger that sends `stack` home sent
// them with it. A browser shows a page none of that, its DOM's frames
// included, since they are native code there.
//
// Node and Bun both format a stack with the `Error.prepareStackTrace` of
// the realm that made the error, read as a property each time, and hand it
// the runtime's call sites, the host's frames among them. Their
// `getFunction()` and `getThis()` answer the host's functions, and on Bun
// the call sites and the list they come in are objects of the host's realm,
// whose `constructor.constructor` is the host's `Function`. So what the
// runtime reads there is always a function of this module's. Where the page
// has set no formatter it is `prepareStackTrace`, which keeps the page's
// frames as the runtime writes them, the built-ins between them, and none
// of the facade's, and stops at the first of the host's — a `node:` module,
// an entry the engine runs (`engine:__timer`), a file by its path — since
// the host enters the context only through `vm`, so that nothing under it
// is the page's.
//
// A page may set a formatter of its own, as a page in Chrome does: vscode's
// extension host defines one with `Object.defineProperty`, and a library
// that wants its caller's file sets one, reads a stack and puts the old one
// back. The property the runtime reads is an accessor of this module's,
// which nothing can redefine, and the page's is a property kept beside it
// (`own`): what the page assigns goes to the setter, and what it defines or
// asks the descriptor of goes through `Object.defineProperty` and its kin,
// which answer for that one property from `own`. What the page reads is a
// wrapper of its formatter (`wrap`), one for each, which hands it call
// sites of this realm's (`CallSite`) for the frames `prepareStackTrace`
// would have kept, whose methods answer primitives and nothing else, and
// whose `getThis()` and `getFunction()` answer `undefined`, as V8's do for
// strict code. A wrapper assigned or defined is its formatter again, so a
// formatter read and put back is the formatter. Six things are
// load-bearing:
//
//   - **No reader is told apart from another.** The runtime reads the
//     formatter as a page does, and on Bun outside the guard that keeps it
//     from formatting a stack inside the formatter, so nothing in the getter
//     can say who asked: whatever it answers is safe to hand the runtime.
//     That is why a page reads its formatter's wrapper and not its
//     formatter, and this module's formatter where it set none.
//   - **A call from the runtime is told from a page's by the list it
//     hands over**: one holding a call site of the runtime's, which no page
//     ever has, or a list of another realm's, as Bun's is. Anything else is
//     the page's own, handed on as it came.
//   - **Node asks the error's global for `Error`**, and a page that put an
//     object of its own there was handed the call sites by Node itself, so
//     the global's `Error` is locked. Bun asks the realm's own.
//   - **Nothing a page can reach touches a host frame.** A call site's
//     methods are taken from one before any page code runs, a page's call
//     site holds the runtime's in a map no page reaches, and the host's
//     file names are read with no method of `String.prototype`, which a
//     page can replace and be handed the name as its `this`. What runs once
//     page code can have run writes nothing through `[[Set]]`, which a
//     setter on `Object.prototype` or `Array.prototype` would hear: it
//     defines, and its own records have no prototype.
//   - **Bun's `Error.captureStackTrace` writes its own stack**, in
//     JavaScriptCore's format and without the formatter, so there it is
//     wrapped: the runtime's captures onto an object of this realm's,
//     whose stack is cut as the formatter cuts one and set on the target,
//     since a target that is a page's `Proxy` would be handed the stack as
//     the runtime defines it. Where the page has a formatter, the wrapper
//     has the runtime format an error of its own to read the call sites,
//     and hands the page's formatter those after the constructor it names.
//   - **What the facade evaluates for the page is the page's**, a string
//     timer or an `on…` attribute, and is named as a browser names it,
//     `<anonymous>`, where the runtime names the facade's place.
//
// One way through is left, and nothing here can close it: page code that
// runs while the runtime formats a stack. The runtime formats any stack
// first read then itself, with every frame it captured, and calls no
// formatter that could cut them. A page's formatter runs then, and so does
// a getter on its error's `name` or `message`, and an error made before
// either and read in it shows the host's frames. Bun's `captureStackTrace`
// is the exception, since its wrapper calls the page's formatter once the
// runtime is done.

/** The name the facade's code is compiled under, which its frames carry. */
export const FACADE = 'engine:facade';

/**
 * Locks the realm's stacks to the page's own frames. What it answers takes
 * the facade's way of marking a function as a built-in's
 * (`installDom`'s native-code `toString`), and marks with it everything
 * made here that a page can reach, then and from then on.
 */
export function lockStacks(
  facade: string,
): (mark: (fn: unknown) => void) => void {
  'use strict';
  type Any = any;
  const apply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const defineProperties = Object.defineProperties;
  const describe = Object.getOwnPropertyDescriptor;
  const describeAll = Object.getOwnPropertyDescriptors;
  const reflectDefine = Reflect.defineProperty;
  const reflectDescribe = Reflect.getOwnPropertyDescriptor;
  const ownKeys = Reflect.ownKeys;
  const create = Object.create;
  const getPrototypeOf = Object.getPrototypeOf;
  const setPrototypeOf = Object.setPrototypeOf;
  const isArray = Array.isArray;
  const ArrayProto = Array.prototype;
  const hasOwn = Object.hasOwn;
  const same = Object.is;
  const toObject = Object;
  const NONE: readonly unknown[] = Object.freeze([]);
  const errorText = Error.prototype.toString;
  const TypeError_ = TypeError;
  const Error_ = Error;
  const String_ = String;
  const mapGet = WeakMap.prototype.get;
  const mapSet = WeakMap.prototype.set;
  const KEY = 'prepareStackTrace';
  /** A property defined as `[[Set]]` would create it, heard by no setter. */
  const put = (target: Any, key: Any, value: Any): void => {
    defineProperty(target, key, {
      __proto__: null,
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    } as PropertyDescriptor);
  };
  /** A built-in's: writable, configurable and not enumerable. */
  const install = (target: Any, key: string, value: Any): void => {
    defineProperty(target, key, {
      __proto__: null,
      value,
      writable: true,
      enumerable: false,
      configurable: true,
    } as PropertyDescriptor);
  };
  /** What a page can reach of this module's, marked once the facade says
   *  how, and marked as it is made from then on. */
  const made: Any[] = [];
  let count = 0;
  let mark: Any = null;
  const keep = <T>(fn: T): T => {
    if (mark !== null) mark(fn);
    else {
      put(made, count, fn);
      count += 1;
    }
    return fn;
  };

  // a call site of the runtime's, for the methods every one shares, and
  // whether the runtime's `captureStackTrace` asks a formatter at all
  let asked = false;
  defineProperty(Error, KEY, {
    value: (_error: Any, sites: Any) => {
      asked = true;
      return sites;
    },
    writable: true,
    configurable: true,
  });
  const site = getPrototypeOf((new Error() as Any).stack[0]);
  const fileOf: Any = site.getFileName;
  const isEval: Any = site.isEval;
  const isNative: Any = site.isNative;
  const originOf: Any = site.getEvalOrigin;
  const siteText: Any = site.toString;
  const functionOf: Any = site.getFunction;
  const capture: Any = (Error as Any).captureStackTrace;
  let captureAsks = true;
  if (typeof capture === 'function') {
    asked = false;
    const held: Any = create(null);
    apply(capture, Error, [held]);
    void held.stack;
    captureAsks = asked;
  }
  /** What a call site of V8's answers, as Chrome's has it, and the
   *  runtime's method of each name, or null where it has none: Bun's has
   *  fewer. */
  const METHODS = [
    'getColumnNumber',
    'getEnclosingColumnNumber',
    'getEnclosingLineNumber',
    'getEvalOrigin',
    'getFileName',
    'getFunction',
    'getFunctionName',
    'getLineNumber',
    'getMethodName',
    'getPosition',
    'getPromiseIndex',
    'getScriptNameOrSourceURL',
    'getScriptHash',
    'getThis',
    'getTypeName',
    'isAsync',
    'isConstructor',
    'isEval',
    'isNative',
    'isPromiseAll',
    'isToplevel',
    'toString',
  ];
  const real: Any = create(null);
  for (let i = 0; i < METHODS.length; i += 1) {
    const name = METHODS[i];
    real[name] = typeof site[name] === 'function' ? site[name] : null;
  }

  // a host's file name read without a method of the page's
  const starts = (text: string, part: string, at = 0): boolean => {
    if (at < 0 || text.length - at < part.length) return false;
    for (let i = 0; i < part.length; i += 1) {
      if (text[at + i] !== part[i]) return false;
    }
    return true;
  };
  const find = (text: string, part: string, from = 0): number => {
    for (let i = from; i + part.length <= text.length; i += 1) {
      if (starts(text, part, i)) return i;
    }
    return -1;
  };
  const findLast = (text: string, part: string): number => {
    for (let i = text.length - part.length; i >= 0; i -= 1) {
      if (starts(text, part, i)) return i;
    }
    return -1;
  };
  const cut = (text: string, from: number, to = text.length): string => {
    let out = '';
    for (let i = from; i < to; i += 1) out += text[i];
    return out;
  };

  const PAGE = 0;
  const BUILTIN = 1;
  const FACADE_FRAME = 2;
  const HOST = 3;
  /** Code the facade evaluated for the page, which Bun names after the
   *  facade's file. */
  const evaluated = `file:///${facade}`;
  /** Which of the four a frame in a file is. */
  const kindOfFile = (file: string): number => {
    if (file === facade || file === 'evalmachine.<anonymous>') {
      return FACADE_FRAME;
    }
    if (starts(file, 'engine:') || starts(file, 'node:')) return HOST;
    if (file === '[native code]' || file === '[unknown]') return BUILTIN;
    // a path, where a page's script is at an address: a module of the
    // host's, as Bun names them and as Node does where source maps are on
    const first = file[0];
    if (first === '/' || first === '\\') return HOST;
    if (
      file.length > 2 &&
      file[1] === ':' &&
      (file[2] === '\\' || file[2] === '/')
    ) {
      return HOST;
    }
    return PAGE;
  };
  const kindOf = (s: Any): number => {
    const file = apply(fileOf, s, NONE);
    // Node's built-ins have no file, and nor has what an `eval` ran
    if (typeof file !== 'string' || file === '') {
      return apply(isEval, s, NONE) ? PAGE : BUILTIN;
    }
    if (apply(isNative, s, NONE)) return BUILTIN;
    return kindOfFile(file);
  };
  /** Whether a frame is of code the facade evaluated for the page, which
   *  is at no file the page knows of, and evaluated from nowhere it does. */
  const byFacade = (s: Any): boolean => {
    if (apply(fileOf, s, NONE) === evaluated) return true;
    if (!apply(isEval, s, NONE)) return false;
    const origin = apply(originOf, s, NONE);
    return typeof origin === 'string' && find(origin, facade) >= 0;
  };
  /** A frame of the page's as the runtime writes it, but for code the
   *  facade evaluated for it, which is at no file. */
  const textOf = (s: Any): string => {
    const text: string = apply(siteText, s, NONE);
    const origin = apply(isEval, s, NONE) ? apply(originOf, s, NONE) : null;
    if (typeof origin === 'string' && find(origin, facade) >= 0) {
      // `eval (eval at invoke (engine:facade:7:16798), <anonymous>:3:13)`
      const from = find(text, 'eval at ');
      const to = findLast(text, ', ');
      if (from >= 0 && to > from) return cut(text, 0, from) + cut(text, to + 2);
    }
    const at = find(text, evaluated);
    return at < 0
      ? text
      : cut(text, 0, at) + '<anonymous>' + cut(text, at + evaluated.length);
  };

  /** Whether a list is the runtime's: one holding a call site of its,
   *  which no page ever has, or one of another realm's, as Bun's lists
   *  are. A page's list, and Node's of no call sites, are neither. */
  const fromRuntime = (sites: Any): boolean => {
    if (!isArray(sites)) return false;
    for (let i = 0; i < sites.length; i += 1) {
      const one = sites[i];
      if (
        one !== null &&
        (typeof one === 'object' || typeof one === 'function') &&
        getPrototypeOf(one) === site
      ) {
        return true;
      }
    }
    for (let p = getPrototypeOf(sites); p !== null; p = getPrototypeOf(p)) {
      if (p === ArrayProto) return false;
    }
    return true;
  };
  /** The error Bun's `captureStackTrace` has the runtime format, and the
   *  call sites the runtime hands over for it. */
  let capturing: Any = null;
  let captured: Any = null;

  // --- the page's call sites -----------------------------------------------
  //
  // One for each frame the formatter keeps, made in this realm. It holds
  // the runtime's in `held`, which no page reaches, and asks it only for a
  // primitive: a `getThis()` or a `getFunction()` would be the host's
  // function or the facade's, so those answer `undefined`, as V8's do for
  // strict code, where most of a page's code is.
  const held: Any = new WeakMap();
  const primitive = (value: Any): Any =>
    value === null || (typeof value !== 'object' && typeof value !== 'function')
      ? value
      : undefined;
  const answer = (name: string, self: Any): Any => {
    const s = apply(mapGet, held, [self]);
    if (s === undefined) {
      throw new TypeError_(
        `CallSite method ${name} expects CallSite as receiver`,
      );
    }
    if (name === 'getThis' || name === 'getFunction') return undefined;
    if (name === 'toString') return textOf(s);
    if (
      (name === 'getFileName' ||
        name === 'getScriptNameOrSourceURL' ||
        name === 'getEvalOrigin') &&
      byFacade(s)
    ) {
      return undefined;
    }
    if (name === 'isEval' && byFacade(s)) return false;
    const method = real[name];
    return method === null ? null : primitive(apply(method, s, NONE));
  };
  /** V8's, which a page can neither call nor construct. */
  const CallSite: Any = keep(function CallSite() {
    throw new Error_('Not supported');
  });
  const SITE: Any = CallSite.prototype;
  install(SITE, 'constructor', CallSite);
  for (let i = 0; i < METHODS.length; i += 1) {
    const name = METHODS[i];
    // a method, so that it is no constructor and has no `prototype`
    const method = {
      [name](this: Any) {
        return answer(name, this);
      },
    }[name];
    install(SITE, name, keep(method));
  }
  /** The page's call sites for the runtime's, in a list of the page's: the
   *  frames the formatter keeps, after the frame of `skip` where it is a
   *  function (`captureStackTrace`'s constructor). */
  const pageSites = (sites: Any, skip: Any): Any => {
    const out: Any = [];
    let n = 0;
    let i = 0;
    if (skip !== null) {
      while (i < sites.length && apply(functionOf, sites[i], NONE) !== skip) {
        i += 1;
      }
      i += 1;
    }
    // where the built-ins since the page's last frame start
    let from = -1;
    for (; i < sites.length; i += 1) {
      const kind = kindOf(sites[i]);
      if (kind === HOST) break;
      if (kind === FACADE_FRAME) {
        from = -1;
        continue;
      }
      if (kind === BUILTIN) {
        if (from < 0) from = i;
        continue;
      }
      for (let j = from < 0 ? i : from; j <= i; j += 1) {
        const one = create(SITE);
        apply(mapSet, held, [one, sites[j]]);
        put(out, n, one);
        n += 1;
      }
      from = -1;
    }
    return out;
  };

  // --- the formatters --------------------------------------------------------

  /** What the runtime is handed where the page set no formatter. */
  const prepareStackTrace = keep(function prepareStackTrace(
    error: Any,
    sites: Any,
  ): string {
    if (capturing !== null && error === capturing) {
      captured = sites;
      return '';
    }
    let out: string = apply(errorText, error, NONE);
    if (!fromRuntime(sites)) {
      // a page's call, with what it holds: formatted as handed
      if (isArray(sites)) {
        for (let i = 0; i < sites.length; i += 1) {
          out += '\n    at ' + String_(sites[i]);
        }
      }
      return out;
    }
    // the built-ins since the page's last frame, kept where another of the
    // page's follows them, and dropped where the facade or the host does
    let between = '';
    for (let i = 0; i < sites.length; i += 1) {
      const s = sites[i];
      const kind = kindOf(s);
      if (kind === HOST) break;
      if (kind === FACADE_FRAME) {
        between = '';
        continue;
      }
      const line = '\n    at ' + textOf(s);
      if (kind === BUILTIN) between += line;
      else {
        out += between + line;
        between = '';
      }
    }
    return out;
  });
  /** A page's formatter's wrapper, and each wrapper's formatter. */
  const wrappers: Any = new WeakMap();
  const wrapped: Any = new WeakMap();
  /** What the runtime is handed for a formatter of the page's: the page's
   *  call sites, for the runtime's, and what a page hands it as it came. */
  const wrap = (formatter: Any): Any => {
    const known = apply(mapGet, wrappers, [formatter]);
    if (known !== undefined) return known;
    const wrapper = {
      prepareStackTrace(this: Any, error: Any, sites: Any): Any {
        if (capturing !== null && error === capturing) {
          captured = sites;
          return '';
        }
        return fromRuntime(sites)
          ? apply(formatter, Error, [error, pageSites(sites, null)])
          : apply(formatter, this, [error, sites]);
      },
    }.prepareStackTrace;
    apply(mapSet, wrappers, [formatter, wrapper]);
    apply(mapSet, wrapped, [wrapper, formatter]);
    return keep(wrapper);
  };
  /** What a value read as the formatter is to the runtime and the page. */
  const formatterOf = (value: Any): Any => {
    if (typeof value !== 'function' || value === prepareStackTrace) {
      return prepareStackTrace;
    }
    return apply(mapGet, wrapped, [value]) !== undefined ? value : wrap(value);
  };
  /** A value written as the formatter, a wrapper being its formatter. */
  const unwrapped = (value: Any): Any => {
    const formatter = apply(mapGet, wrapped, [value]);
    return formatter === undefined ? value : formatter;
  };

  // --- the page's `Error.prepareStackTrace` ---------------------------------
  //
  // A data property at first, whose value is this module's formatter, as
  // it is again wherever a page reads it and puts it back.
  let own: Any = {
    __proto__: null,
    accessor: false,
    value: prepareStackTrace,
    writable: true,
    get: undefined,
    set: undefined,
    enumerable: false,
    configurable: true,
  };
  /** The page's formatter, read as the runtime reads one. */
  const current = (receiver: Any): Any => {
    const o = own;
    if (!o.accessor) return o.value;
    return o.get === undefined ? undefined : apply(o.get, receiver, NONE);
  };
  const accessor: Any = describe(
    {
      get prepareStackTrace(): Any {
        return formatterOf(current(this));
      },
      // `[[Set]]` on the page's property, as OrdinarySet has it
      set prepareStackTrace(written: Any) {
        const value = unwrapped(written);
        const o = own;
        if (o.accessor) {
          if (o.set !== undefined) apply(o.set, this, [value]);
          return;
        }
        if (!o.writable) return;
        const receiver: Any = this;
        if (receiver === Error) {
          own = {
            __proto__: null,
            accessor: false,
            value,
            writable: true,
            get: undefined,
            set: undefined,
            enumerable: o.enumerable,
            configurable: o.configurable,
          };
          return;
        }
        if (
          receiver === null ||
          (typeof receiver !== 'object' && typeof receiver !== 'function')
        ) {
          return;
        }
        const existing = reflectDescribe(receiver, KEY);
        if (existing === undefined) {
          reflectDefine(receiver, KEY, {
            __proto__: null,
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          } as PropertyDescriptor);
        } else if (hasOwn(existing, 'value') && existing.writable === true) {
          reflectDefine(receiver, KEY, {
            __proto__: null,
            value,
          } as PropertyDescriptor);
        }
      },
    },
    KEY,
  );
  keep(accessor.get);
  keep(accessor.set);
  defineProperty(Error, KEY, {
    __proto__: null,
    get: accessor.get,
    set: accessor.set,
    enumerable: false,
    configurable: false,
  } as PropertyDescriptor);
  defineProperty(globalThis, 'Error', {
    value: Error,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  // --- what the page defines and describes ------------------------------
  //
  // `Object.defineProperty` and its kin, for `Error`'s `prepareStackTrace`
  // alone, act on `own` as the specification acts on a property: the key
  // as `ToPropertyKey` makes it, the descriptor read as
  // `ToPropertyDescriptor` reads it, and the change checked as
  // `ValidateAndApplyPropertyDescriptor` checks it. Anything else is the
  // runtime's, untouched.
  const keyOf = (key: Any): Any => ownKeys({ __proto__: null, [key]: 0 })[0];
  const shown = (value: Any): string =>
    value !== null && (typeof value === 'object' || typeof value === 'function')
      ? '#<Object>'
      : String_(value);
  /** ToPropertyDescriptor, into a record with no prototype. */
  const descriptorOf = (obj: Any): Any => {
    if (
      obj === null ||
      (typeof obj !== 'object' && typeof obj !== 'function')
    ) {
      throw new TypeError_(
        `Property description must be an object: ${shown(obj)}`,
      );
    }
    const d: Any = create(null);
    if ('enumerable' in obj) d.enumerable = !!obj.enumerable;
    if ('configurable' in obj) d.configurable = !!obj.configurable;
    if ('value' in obj) d.value = obj.value;
    if ('writable' in obj) d.writable = !!obj.writable;
    if ('get' in obj) {
      const getter = obj.get;
      if (getter !== undefined && typeof getter !== 'function') {
        throw new TypeError_(`Getter must be a function: ${shown(getter)}`);
      }
      d.get = getter;
    }
    if ('set' in obj) {
      const setter = obj.set;
      if (setter !== undefined && typeof setter !== 'function') {
        throw new TypeError_(`Setter must be a function: ${shown(setter)}`);
      }
      d.set = setter;
    }
    if (('get' in d || 'set' in d) && ('value' in d || 'writable' in d)) {
      throw new TypeError_(
        'Invalid property descriptor. Cannot both specify accessors and a value or writable attribute, #<Object>',
      );
    }
    return d;
  };
  /** ValidateAndApplyPropertyDescriptor over `own`, which always exists. */
  const defineOwn = (d: Any): boolean => {
    const o = own;
    const accessorDesc = 'get' in d || 'set' in d;
    const dataDesc = 'value' in d || 'writable' in d;
    const value = 'value' in d ? unwrapped(d.value) : o.value;
    if (!o.configurable) {
      if (d.configurable === true) return false;
      if ('enumerable' in d && d.enumerable !== o.enumerable) return false;
      if (accessorDesc || dataDesc) {
        if (accessorDesc !== o.accessor) return false;
        if (o.accessor) {
          if ('get' in d && !same(d.get, o.get)) return false;
          if ('set' in d && !same(d.set, o.set)) return false;
        } else if (!o.writable) {
          if (d.writable === true) return false;
          if ('value' in d && !same(value, o.value)) return false;
        }
      }
    }
    const enumerable = 'enumerable' in d ? d.enumerable : o.enumerable;
    const configurable = 'configurable' in d ? d.configurable : o.configurable;
    if (accessorDesc ? !o.accessor : dataDesc && o.accessor) {
      // a data property made an accessor, or the other way, from defaults
      own = {
        __proto__: null,
        accessor: accessorDesc,
        value: accessorDesc ? undefined : 'value' in d ? value : undefined,
        writable: accessorDesc ? false : d.writable === true,
        get: accessorDesc ? d.get : undefined,
        set: accessorDesc ? d.set : undefined,
        enumerable,
        configurable,
      };
      return true;
    }
    own = {
      __proto__: null,
      accessor: o.accessor,
      value,
      writable: 'writable' in d ? d.writable : o.writable,
      get: 'get' in d ? d.get : o.get,
      set: 'set' in d ? d.set : o.set,
      enumerable,
      configurable,
    };
    return true;
  };
  /** FromPropertyDescriptor of `own`: an object of the page's. */
  const ownDescriptor = (): Any => {
    const o = own;
    const out: Any = {};
    if (o.accessor) {
      put(out, 'get', o.get);
      put(out, 'set', o.set);
    } else {
      put(out, 'value', o.value);
      put(out, 'writable', o.writable);
    }
    put(out, 'enumerable', o.enumerable);
    put(out, 'configurable', o.configurable);
    return out;
  };
  /** A record of `descriptorOf`'s as an object the runtime reads alone. */
  const asDescriptor = (d: Any): Any => {
    const out: Any = create(null);
    const keys = ownKeys(d);
    for (let i = 0; i < keys.length; i += 1) out[keys[i]] = d[keys[i]];
    return out;
  };
  const redefine = (): never => {
    throw new TypeError_(`Cannot redefine property: ${KEY}`);
  };
  const objectStatics: Any = {
    defineProperty(target: Any, key: Any, attributes: Any): Any {
      if (target !== Error) return defineProperty(target, key, attributes);
      const k = keyOf(key);
      if (k !== KEY) return defineProperty(target, k, attributes);
      if (!defineOwn(descriptorOf(attributes))) redefine();
      return target;
    },
    defineProperties(target: Any, properties: Any): Any {
      if (target !== Error) return defineProperties(target, properties);
      // ObjectDefineProperties: every descriptor read before any is applied
      if (properties === null || properties === undefined) {
        throw new TypeError_('Cannot convert undefined or null to object');
      }
      const props = toObject(properties);
      const keys = ownKeys(props);
      const list: Any = create(null);
      let n = 0;
      for (let i = 0; i < keys.length; i += 1) {
        const k = keys[i];
        const d = describe(props, k);
        if (d === undefined || !d.enumerable) continue;
        list[n] = { __proto__: null, k, d: descriptorOf(props[k]) };
        n += 1;
      }
      for (let i = 0; i < n; i += 1) {
        const { k, d } = list[i];
        if (k !== KEY) defineProperty(target, k, asDescriptor(d));
        else if (!defineOwn(d)) redefine();
      }
      return target;
    },
    getOwnPropertyDescriptor(target: Any, key: Any): Any {
      if (target !== Error) return describe(target, key);
      const k = keyOf(key);
      return k === KEY ? ownDescriptor() : describe(target, k);
    },
    getOwnPropertyDescriptors(target: Any): Any {
      const all = describeAll(target);
      if (target === Error) put(all, KEY, ownDescriptor());
      return all;
    },
  };
  const reflectStatics: Any = {
    defineProperty(target: Any, key: Any, attributes: Any): Any {
      if (target !== Error) return reflectDefine(target, key, attributes);
      const k = keyOf(key);
      if (k !== KEY) return reflectDefine(target, k, attributes);
      return defineOwn(descriptorOf(attributes));
    },
    getOwnPropertyDescriptor(target: Any, key: Any): Any {
      if (target !== Error) return reflectDescribe(target, key);
      const k = keyOf(key);
      return k === KEY ? ownDescriptor() : reflectDescribe(target, k);
    },
  };
  const statics = [
    [Object, objectStatics],
    [Reflect, reflectStatics],
  ] as const;
  for (let i = 0; i < statics.length; i += 1) {
    const [holder, methods] = statics[i];
    const names = ownKeys(methods);
    for (let j = 0; j < names.length; j += 1) {
      const name = names[j] as string;
      install(holder, name, keep(methods[name]));
    }
  }

  const marking = (by: (fn: unknown) => void): void => {
    mark = by;
    for (let i = 0; i < count; i += 1) by(made[i]);
  };
  if (captureAsks) return marking;
  // Bun's: `name@file:line:column` a line, with no message line, cut as
  // the formatter cuts a stack and left in its format
  const fileOfLine = (line: string): string => {
    const at = find(line, '@');
    let end = line.length;
    // a line and a column at the end, each after a colon
    for (let n = 0; n < 2; n += 1) {
      let i = end;
      while (i > at + 1 && line[i - 1] >= '0' && line[i - 1] <= '9') i -= 1;
      if (i === end || line[i - 1] !== ':') break;
      end = i - 1;
    }
    return cut(line, at + 1, end);
  };
  const cutLines = (text: string): string => {
    let out = '';
    let between = '';
    for (let start = 0; start < text.length;) {
      let end = find(text, '\n', start);
      if (end < 0) end = text.length;
      const line = cut(text, start, end);
      start = end + 1;
      const file = fileOfLine(line);
      // `map@` and `eval code@`: a built-in, and what an `eval` ran
      const kind = file === '' ? BUILTIN : kindOfFile(file);
      if (kind === HOST) break;
      if (kind === FACADE_FRAME) {
        between = '';
        continue;
      }
      const at = find(line, evaluated);
      const shown =
        '\n' +
        (at < 0
          ? line
          : cut(line, 0, at) +
            '<anonymous>' +
            cut(line, at + evaluated.length));
      if (kind === BUILTIN) between += shown;
      else {
        out += between + shown;
        between = '';
      }
    }
    return cut(out, 1);
  };
  /** The call sites the runtime hands a formatter here, read by having it
   *  format an error of this module's, which its formatter, this
   *  module's, hands over instead: null where it hands none. */
  const sitesHere = (): Any => {
    const e: Any = new Error();
    setPrototypeOf(e, null);
    capturing = e;
    captured = null;
    try {
      void e.stack;
    } finally {
      capturing = null;
    }
    const sites = captured;
    captured = null;
    return isArray(sites) && (sites.length === 0 || fromRuntime(sites))
      ? sites
      : null;
  };
  const captureStackTrace = keep(function captureStackTrace(
    target: Any,
    constructorOpt?: Any,
  ): void {
    if (
      target === null ||
      (typeof target !== 'object' && typeof target !== 'function')
    ) {
      // the runtime's `TypeError`
      apply(capture, Error, [target]);
      return;
    }
    const formatter = unwrapped(current(Error));
    if (typeof formatter === 'function' && formatter !== prepareStackTrace) {
      const sites = sitesHere();
      if (sites !== null) {
        const skip =
          typeof constructorOpt === 'function' ? constructorOpt : null;
        defineProperty(target, 'stack', {
          __proto__: null,
          value: apply(formatter, Error, [target, pageSites(sites, skip)]),
          writable: true,
          enumerable: false,
          configurable: true,
        } as PropertyDescriptor);
        return;
      }
    }
    // an object no page has seen, which the runtime writes the whole
    // stack onto: a page's `Object.create` could hand it a `Proxy`
    const held: Any = create(null);
    apply(capture, Error, [
      held,
      typeof constructorOpt === 'function' ? constructorOpt : captureStackTrace,
    ]);
    const text = held.stack;
    defineProperty(target, 'stack', {
      __proto__: null,
      value: typeof text === 'string' ? cutLines(text) : text,
      writable: true,
      enumerable: false,
      configurable: true,
    } as PropertyDescriptor);
  });
  defineProperty(Error, 'captureStackTrace', {
    value: captureStackTrace,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return marking;
}
