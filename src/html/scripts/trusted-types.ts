// Trusted Types as a page sees them (W3C Trusted Types): `trustedTypes`, the
// policies a page makes with it, and the three types they make.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing.
//
// What is here is the API: a policy's callbacks run as the specification
// runs them, what they answer is kept where no page can change it, and a
// value is told apart by that alone (`isHTML` and its kin). A policy's
// name is held to the document's `trusted-types` directives, which the host
// asks of its policies and reports a violation of, as it does every other.
// What is not here yet is the other half, a sink that refuses a string under
// `require-trusted-types-for 'script'`: every sink still takes a string,
// and a Trusted value is the string it holds wherever one is set.

/** What `installDom` hands this. */
export interface TrustedTypesDeps {
  /** A bridge call: `csp`'s `tt` asks whether a policy may be made. */
  host(op: string, a?: unknown, b?: unknown, c?: unknown): unknown;
  /** Whether an attribute's name is one of an event handler's. */
  eventHandler(name: string): boolean;
}

export function installTrustedTypes(deps: TrustedTypesDeps) {
  'use strict';
  type Any = any;
  const TOKEN = Object.freeze(Object.create(null));
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  const lower = (s: string): string =>
    s.replace(/[A-Z]/g, (c) => c.toLowerCase());

  /** What each Trusted value holds, by the value: a page can read it and
   *  never change it. */
  const DATA = new WeakMap<object, { kind: string; data: string }>();
  const make = (kind: string, data: string, C: Any): Any => {
    const value = new C(TOKEN);
    DATA.set(value, { kind, data });
    return value;
  };
  const dataOf = (value: Any, kind: string): string => {
    const d = DATA.get(value);
    if (!d || d.kind !== kind) throw new TypeError('Illegal invocation');
    return d.data;
  };
  /** Whether a value is a template literal's strings, with no substitution
   *  (`fromLiteral`'s "is a template literal object"). */
  const literal = (strings: Any): boolean =>
    Array.isArray(strings) &&
    Object.isFrozen(strings) &&
    Array.isArray((strings as Any).raw) &&
    Object.isFrozen((strings as Any).raw) &&
    strings.length === 1;

  class TrustedHTML {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw new TypeError('Illegal constructor');
    }
    toString(): string {
      return dataOf(this, 'html');
    }
    toJSON(): string {
      return dataOf(this, 'html');
    }
    static fromLiteral(templateStringsArray: Any): Any {
      if (!literal(templateStringsArray)) {
        throw new TypeError(
          "Failed to execute 'fromLiteral' on 'TrustedHTML': The argument is not a template literal.",
        );
      }
      return make('html', String(templateStringsArray[0]), TrustedHTML);
    }
  }
  class TrustedScript {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw new TypeError('Illegal constructor');
    }
    toString(): string {
      return dataOf(this, 'script');
    }
    toJSON(): string {
      return dataOf(this, 'script');
    }
    static fromLiteral(templateStringsArray: Any): Any {
      if (!literal(templateStringsArray)) {
        throw new TypeError(
          "Failed to execute 'fromLiteral' on 'TrustedScript': The argument is not a template literal.",
        );
      }
      return make('script', String(templateStringsArray[0]), TrustedScript);
    }
  }
  class TrustedScriptURL {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw new TypeError('Illegal constructor');
    }
    toString(): string {
      return dataOf(this, 'url');
    }
    toJSON(): string {
      return dataOf(this, 'url');
    }
    static fromLiteral(templateStringsArray: Any): Any {
      if (!literal(templateStringsArray)) {
        throw new TypeError(
          "Failed to execute 'fromLiteral' on 'TrustedScriptURL': The argument is not a template literal.",
        );
      }
      return make('url', String(templateStringsArray[0]), TrustedScriptURL);
    }
  }

  /** Each policy's name and the callbacks its options named, read once. */
  const POLICIES = new WeakMap<object, Any>();
  const CREATE = [
    ['createHTML', 'html', TrustedHTML, 'TrustedHTML'],
    ['createScript', 'script', TrustedScript, 'TrustedScript'],
    ['createScriptURL', 'url', TrustedScriptURL, 'TrustedScriptURL'],
  ] as const;

  /** "Create a Trusted Type": what the policy's callback answers, as a
   *  string, the empty one for null or undefined. */
  const create = (
    policy: Any,
    member: string,
    kind: string,
    C: Any,
    value: Any,
    args: Any[],
  ): Any => {
    const p = POLICIES.get(policy);
    if (!p) throw new TypeError('Illegal invocation');
    const fn = p[member];
    if (fn === null || fn === undefined) {
      throw new TypeError(
        `Failed to execute '${member}' on 'TrustedTypePolicy': Policy ${p.name}'s TrustedTypePolicyOptions did not specify a '${member}' member.`,
      );
    }
    const answer = fn.call(undefined, String(value), ...args);
    return make(
      kind,
      answer === null || answer === undefined ? '' : String(answer),
      C,
    );
  };

  class TrustedTypePolicy {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw new TypeError('Illegal constructor');
    }
    get name(): string {
      const p = POLICIES.get(this);
      if (!p) throw new TypeError('Illegal invocation');
      return p.name;
    }
    createHTML(input: Any, ...args: Any[]): Any {
      return create(this, 'createHTML', 'html', TrustedHTML, input, args);
    }
    createScript(input: Any, ...args: Any[]): Any {
      return create(this, 'createScript', 'script', TrustedScript, input, args);
    }
    createScriptURL(input: Any, ...args: Any[]): Any {
      return create(
        this,
        'createScriptURL',
        'url',
        TrustedScriptURL,
        input,
        args,
      );
    }
  }

  const created: string[] = [];
  let defaultPolicy: Any = null;
  const EMPTY_HTML = make('html', '', TrustedHTML);
  const EMPTY_SCRIPT = make('script', '', TrustedScript);

  /** "Get Trusted Type data for attribute": the type an attribute of an
   *  element of a namespace is a sink for, or null. */
  const attributeType = (
    local: string,
    namespace: string,
    attribute: string,
    attributeNs: string | null,
  ): string | null => {
    if (
      attributeNs === null &&
      (namespace === HTML_NS ||
        namespace === SVG_NS ||
        namespace === MATHML_NS) &&
      attribute.startsWith('on') &&
      deps.eventHandler(attribute)
    ) {
      return 'TrustedScript';
    }
    if (namespace === HTML_NS && attributeNs === null) {
      if (local === 'iframe' && attribute === 'srcdoc') return 'TrustedHTML';
      if (local === 'script' && attribute === 'src') return 'TrustedScriptURL';
    }
    if (
      namespace === SVG_NS &&
      local === 'script' &&
      attribute === 'href' &&
      (attributeNs === null || attributeNs === XLINK_NS)
    ) {
      return 'TrustedScriptURL';
    }
    return null;
  };

  class TrustedTypePolicyFactory {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw new TypeError('Illegal constructor');
    }
    createPolicy(policyName: Any, policyOptions: Any = undefined): Any {
      if (arguments.length === 0) {
        throw new TypeError(
          "Failed to execute 'createPolicy' on 'TrustedTypePolicyFactory': 1 argument required, but only 0 present.",
        );
      }
      const name = String(policyName);
      // the options, a dictionary, read in its members' order, each a
      // callback or nothing
      const options =
        policyOptions === undefined || policyOptions === null
          ? {}
          : policyOptions;
      if (typeof options !== 'object' && typeof options !== 'function') {
        throw new TypeError(
          "Failed to execute 'createPolicy' on 'TrustedTypePolicyFactory': The provided value is not of type 'TrustedTypePolicyOptions'.",
        );
      }
      const read: Any = { name };
      for (const [member] of CREATE) {
        const fn = options[member];
        if (fn !== undefined && fn !== null && typeof fn !== 'function') {
          throw new TypeError(
            `Failed to execute 'createPolicy' on 'TrustedTypePolicyFactory': The provided value for '${member}' is not a function.`,
          );
        }
        read[member] = fn ?? null;
      }
      // the document's `trusted-types` directives, asked by the host
      // (Trusted Types, "Should Trusted Type policy creation be blocked by
      // Content Security Policy?")
      if (deps.host('csp', 'tt', name, JSON.stringify(created)) !== true) {
        throw new TypeError(
          `Failed to execute 'createPolicy' on 'TrustedTypePolicyFactory': Policy "${name}" disallowed.`,
        );
      }
      if (name === 'default' && defaultPolicy) {
        throw new TypeError(
          "Failed to execute 'createPolicy' on 'TrustedTypePolicyFactory': Policy \"default\" already exists.",
        );
      }
      const policy = new TrustedTypePolicy(TOKEN);
      POLICIES.set(policy, read);
      created.push(name);
      if (name === 'default') defaultPolicy = policy;
      return policy;
    }
    isHTML(value: Any): boolean {
      return DATA.get(value)?.kind === 'html';
    }
    isScript(value: Any): boolean {
      return DATA.get(value)?.kind === 'script';
    }
    isScriptURL(value: Any): boolean {
      return DATA.get(value)?.kind === 'url';
    }
    get emptyHTML(): Any {
      return EMPTY_HTML;
    }
    get emptyScript(): Any {
      return EMPTY_SCRIPT;
    }
    getAttributeType(
      tagName: Any,
      attribute: Any,
      elementNs: Any = '',
      attrNs: Any = '',
    ): string | null {
      const ns =
        elementNs === null || String(elementNs) === ''
          ? HTML_NS
          : String(elementNs);
      const attributeNs =
        attrNs === null || String(attrNs) === '' ? null : String(attrNs);
      return attributeType(
        lower(String(tagName)),
        ns,
        lower(String(attribute)),
        attributeNs,
      );
    }
    getPropertyType(
      tagName: Any,
      property: Any,
      elementNs: Any = '',
    ): string | null {
      const local = lower(String(tagName));
      const ns =
        elementNs === null || String(elementNs) === ''
          ? HTML_NS
          : String(elementNs);
      const name = String(property);
      if (ns === HTML_NS) {
        if (local === 'iframe' && name === 'srcdoc') return 'TrustedHTML';
        if (local === 'script') {
          if (name === 'src') return 'TrustedScriptURL';
          if (
            name === 'text' ||
            name === 'innerText' ||
            name === 'textContent'
          ) {
            return 'TrustedScript';
          }
        }
      }
      if (name === 'innerHTML' || name === 'outerHTML') return 'TrustedHTML';
      return null;
    }
    get defaultPolicy(): Any {
      return defaultPolicy;
    }
  }

  // what Web IDL makes of an interface's members: enumerable, and a class
  // string of its own
  for (const C of [
    TrustedHTML,
    TrustedScript,
    TrustedScriptURL,
    TrustedTypePolicy,
    TrustedTypePolicyFactory,
  ] as Any[]) {
    for (const on of [C.prototype, C]) {
      for (const key of Object.getOwnPropertyNames(on)) {
        if (['constructor', 'prototype', 'length', 'name'].includes(key))
          continue;
        const d = Object.getOwnPropertyDescriptor(on, key) as Any;
        Object.defineProperty(on, key, { ...d, enumerable: true });
      }
    }
    Object.defineProperty(C.prototype, Symbol.toStringTag, {
      value: C.name,
      configurable: true,
    });
  }

  /** Whether the document's policies require Trusted Types of the sinks
   *  that take script, as the host says it (`t`). */
  let required = false;
  const KINDS: Record<string, [string, string]> = {
    TrustedHTML: ['html', 'createHTML'],
    TrustedScript: ['script', 'createScript'],
    TrustedScriptURL: ['url', 'createScriptURL'],
  };
  /**
   * What a sink is handed, as the string it takes (Trusted Types, "Get
   * Trusted Type compliant string"): a value of the type the sink takes is
   * its string; anything else is its string where nothing requires Trusted
   * Types, and else what the default policy makes of it, which is handed
   * the type and the sink's name. Where that is nothing, the host is told,
   * and an enforced policy makes it a `TypeError`.
   */
  const comply = (value: Any, type: string, sink: string): string => {
    const [kind, member] = KINDS[type];
    const held = DATA.get(value);
    if (held && held.kind === kind) return held.data;
    const text = String(value);
    if (!required) return text;
    const p = defaultPolicy ? POLICIES.get(defaultPolicy) : null;
    const fn = p?.[member];
    if (fn) {
      const answer = fn.call(undefined, text, type, sink);
      if (answer !== null && answer !== undefined) return String(answer);
    }
    if (deps.host('csp', 'ttSink', sink, text) !== true) {
      throw new TypeError(
        `${sink}: This document requires '${type}' assignment.`,
      );
    }
    return text;
  };
  /** The type an attribute of an element is a sink for, and the sink's
   *  name, or null (`attributeType`). */
  const sinkOfAttribute = (
    local: string,
    namespace: string,
    attribute: string,
    attributeNs: string | null,
    iface: string,
  ): [string, string] | null => {
    const type = attributeType(local, namespace, lower(attribute), attributeNs);
    if (!type) return null;
    const name = lower(attribute);
    return [
      type,
      type === 'TrustedScript' && name.startsWith('on')
        ? `Element ${name}`
        : `${iface} ${name}`,
    ];
  };

  const factory = new TrustedTypePolicyFactory(TOKEN);
  return {
    comply,
    sinkOfAttribute,
    isHTML: (value: Any): boolean => DATA.get(value)?.kind === 'html',
    /** A TrustedScript's string, or undefined for anything else. */
    scriptData: (value: Any): string | undefined => {
      const held = DATA.get(value);
      return held?.kind === 'script' ? held.data : undefined;
    },
    get required(): boolean {
      return required;
    },
    policyChanged(said: string): void {
      if (said.includes('t')) required = true;
    },
    interfaces: {
      TrustedHTML,
      TrustedScript,
      TrustedScriptURL,
      TrustedTypePolicy,
      TrustedTypePolicyFactory,
    },
    factory,
  };
}
