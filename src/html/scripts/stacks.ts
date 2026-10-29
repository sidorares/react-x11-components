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
// the realm that made the error, so the context's is this formatter,
// locked, as the engine's rule 3 always locked it: a page that set its own
// would be handed the call sites, the host's among them. It keeps the
// page's frames as the runtime writes them, the built-ins between them, and
// none of the facade's, and stops at the first of the host's — a `node:`
// module, an entry the engine runs (`engine:__timer`), a file by its path —
// since the host enters the context only through `vm`, so that nothing
// under it is the page's. Four things are load-bearing:
//
//   - **Node asks the error's global for `Error`**, and a page that put an
//     object of its own there was handed the call sites by Node itself, so
//     the global's `Error` is locked too. Bun asks the realm's own.
//   - **Nothing a page can reach touches a host frame.** A call site's
//     methods are taken from one before any page code runs, and the host's
//     file names are read with no method of `String.prototype`, which a
//     page can replace and be handed the name as its `this`.
//   - **Bun's `Error.captureStackTrace` writes its own stack**, in
//     JavaScriptCore's format and without the formatter, so there it is
//     wrapped: the runtime's captures onto an object of this realm's,
//     whose stack is cut as the formatter cuts one and set on the target,
//     since a target that is a page's `Proxy` would be handed the stack as
//     the runtime defines it.
//   - **What the facade evaluates for the page is the page's**, a string
//     timer or an `on…` attribute, and is named as a browser names it,
//     `<anonymous>`, where the runtime names the facade's place.

/** The name the facade's code is compiled under, which its frames carry. */
export const FACADE = 'engine:facade';

export function lockStacks(facade: string): void {
  'use strict';
  type Any = any;
  const apply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const create = Object.create;
  const NONE: readonly unknown[] = Object.freeze([]);
  const errorText = Error.prototype.toString;

  // a call site of this realm's, for the methods every one shares, and
  // whether the runtime's `captureStackTrace` asks a formatter at all
  let asked = false;
  defineProperty(Error, 'prepareStackTrace', {
    value: (_error: Any, sites: Any) => {
      asked = true;
      return sites;
    },
    writable: true,
    configurable: true,
  });
  const site = Object.getPrototypeOf((new Error() as Any).stack[0]);
  const fileOf: Any = site.getFileName;
  const isEval: Any = site.isEval;
  const isNative: Any = site.isNative;
  const originOf: Any = site.getEvalOrigin;
  const siteText: Any = site.toString;
  const capture: Any = (Error as Any).captureStackTrace;
  let captureAsks = true;
  if (typeof capture === 'function') {
    asked = false;
    const held: Any = create(null);
    apply(capture, Error, [held]);
    void held.stack;
    captureAsks = asked;
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

  const prepareStackTrace = function prepareStackTrace(
    error: Any,
    sites: Any,
  ): string {
    let out: string = apply(errorText, error, NONE);
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
  };
  defineProperty(Error, 'prepareStackTrace', {
    value: prepareStackTrace,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  defineProperty(globalThis, 'Error', {
    value: Error,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  if (captureAsks) return;
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
  const captureStackTrace = function captureStackTrace(
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
  };
  defineProperty(Error, 'captureStackTrace', {
    value: captureStackTrace,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}
