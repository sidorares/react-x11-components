// A document's Content Security Policy as its host holds it (CSP 3): the
// policies its response and its `<meta>`s brought, enforced or reported, and
// every question a request, an inline script or style, an `on…` attribute, a
// `javascript:` URL and a string compiled as script put to them, with the
// violations they come to told.
//
// The algorithms are `../csp.ts`'s, pure; this is where they meet a
// document. A violation goes two ways, as CSP 3, 5.3 has it: to the page, as
// a `securitypolicyviolation` event at the element it was about where that
// is in the document, else at the document (`tell`, a task later); and to
// the policy's `report-uri` or `report-to` endpoint, as a report the host
// sends through the document's network (`send`). Neither waits on the other,
// and neither is asked whether to enforce: a policy reported only enforces
// nothing, and one enforced refuses whatever the page does with the event.
import {
  directiveFor,
  effectiveDirective,
  evalMatches,
  inlineDirective,
  inlineMatches,
  matchesSourceList,
  parsePolicyList,
  policiesOfHeaders,
  reportedUrl,
  requestMatches,
  upgradedUrl,
  wantsSample,
} from '../csp.js';
import type {
  CspPolicy,
  CspPolicyEntry,
  CspRequest,
  InlineType,
} from '../csp.js';
import type { Element } from 'domhandler';
import { namedAttributeTwice } from '../dom.js';
import { nodeModule } from './platform.js';

interface CryptoModule {
  createHash(name: string): {
    update(text: string, encoding: 'utf8'): { digest(enc: 'base64'): string };
  };
}
const { createHash } = await nodeModule<CryptoModule>('crypto');

/** An element's nonce, as CSP reads it (HTML's `nonce` content attribute;
 *  CSP 3, 6.7.3.1, "Is element nonceable?"): none where an attribute's name
 *  or value holds `<script` or `<style`, which a markup injection could
 *  have put there beside a nonce it found. */
export function cspNonceOf(
  element: { attribs: Record<string, string> } | null | undefined,
  /** Its nonce where that is no longer its attribute's (HTML 2.6.3). */
  slot?: string,
): string {
  const nonce = slot ?? element?.attribs.nonce;
  if (!element || !nonce) return '';
  // nor where its start tag named an attribute twice (HTML 2.6.3)
  if (namedAttributeTwice(element as Element)) return '';
  for (const [name, value] of Object.entries(element.attribs)) {
    if (/<(script|style)/i.test(name) || /<(script|style)/i.test(value)) {
      return '';
    }
  }
  return nonce;
}

/** A digest of text as UTF-8, base64, as a hash-source compares one. */
const digest = (algorithm: string, text: string): string =>
  createHash(algorithm).update(text, 'utf8').digest('base64');

/** What a violation tells, as `SecurityPolicyViolationEvent` has it. */
export interface CspViolation {
  documentURI: string;
  referrer: string;
  blockedURI: string;
  effectiveDirective: string;
  violatedDirective: string;
  originalPolicy: string;
  sourceFile: string;
  sample: string;
  disposition: 'enforce' | 'report';
  statusCode: number;
  lineNumber: number;
  columnNumber: number;
}

/** Where a check was made from, for a report: the script or the document,
 *  and the place in it. */
export interface CspWhere {
  sourceFile?: string;
  lineNumber?: number;
  columnNumber?: number;
}

/** What the host tells and sends through. */
export interface CspSeams<T> {
  /** The document's address, its origin and the referrer it was loaded
   *  with. */
  url(): string;
  origin(): string;
  referrer(): string;
  /** The status its response came with: 0 for a document of no response. */
  status(): number;
  /** A violation told to the page, at `target` where it is about one. */
  tell(violation: CspViolation, target: T | null): void;
  /** A report sent: its body, as JSON, of its content type, to a URL. */
  send(url: string, body: string, type: string): void;
  /** Where a `report-to` group sends, from the response's headers. */
  endpoint?(group: string): string | null;
  /** The policies changed what the page's guards hold to: `p` once there is
   *  a policy, `e` once one speaks of string compilation, `w` of
   *  WebAssembly. */
  changed?(said: string): void;
  /** Where a violation was caused, where the caller said nothing: the
   *  page's code that is running, or the place of what it is about in the
   *  document (CSP 3, 5.3, "create a violation object"). */
  where?(target: T | null): CspWhere;
}

/** A frame of a stack as V8 hands it to `Error.prepareStackTrace`. */
interface CallSite {
  getFileName(): string | null | undefined;
  getLineNumber(): number | null;
  getColumnNumber(): number | null;
  isNative(): boolean;
}

/** The name the facade's code is compiled under (`stacks.ts`'s `FACADE`),
 *  and the one the runtime gives what it evaluates with no name. */
const FACADE_FILES = new Set(['engine:facade', 'evalmachine.<anonymous>']);

/**
 * Where the page's code that is running is, where it is: the innermost frame
 * of its own under the facade it called into (CSP 3, 5.3: "if the user agent
 * is currently executing script"), read off the host's stack, whose frames
 * cross into the context. Null where no page code is under the call, and on a
 * runtime whose `captureStackTrace` hands no call sites over (Bun).
 */
export function runningScriptAt(): CspWhere | null {
  const E = Error as unknown as {
    prepareStackTrace?: unknown;
    stackTraceLimit?: number;
    captureStackTrace?: (target: object) => void;
  };
  if (typeof E.captureStackTrace !== 'function') return null;
  const format = E.prepareStackTrace;
  const limit = E.stackTraceLimit;
  let sites: unknown = null;
  try {
    E.prepareStackTrace = (_error: unknown, given: unknown) => given;
    E.stackTraceLimit = 200;
    const held: { stack?: unknown } = {};
    E.captureStackTrace(held);
    sites = held.stack;
  } finally {
    E.prepareStackTrace = format;
    E.stackTraceLimit = limit;
  }
  if (!Array.isArray(sites)) return null;
  let inFacade = false;
  for (const site of sites as CallSite[]) {
    const file = site.getFileName();
    if (typeof file === 'string' && FACADE_FILES.has(file)) {
      inFacade = true;
      continue;
    }
    // the host's own frames, above the facade the page called
    if (!inFacade) continue;
    if (site.isNative() || typeof file !== 'string' || file === '') continue;
    // the host, under which nothing is the page's
    if (file.startsWith('node:') || file.startsWith('engine:')) return null;
    return {
      sourceFile: file,
      lineNumber: site.getLineNumber() ?? 0,
      columnNumber: site.getColumnNumber() ?? 0,
    };
  }
  return null;
}

/**
 * What a violation of `frame-src` says it was about where the frame was
 * sent to another origin: that origin alone, as browsers cut a document's
 * address another origin's frame was refused (WPT's
 * `report-only-cross-origin-frame`), where an image's is its whole URL.
 * Null for any other.
 */
function frameBlocked(
  effective: string,
  url: string,
  self: string,
): string | null {
  if (effective !== 'frame-src') return null;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  return origin !== 'null' && origin !== self ? origin : null;
}

/** The first characters of what a violation is about, which a policy that
 *  asks for one (`'report-sample'`) is told (CSP 3, 5.3, step 2). */
const SAMPLE_LENGTH = 40;

/** A document's policies, and what it asks of them. */
export class PageCsp<T = unknown> {
  readonly policies: CspPolicyEntry[] = [];
  /** The `<meta>`s already heard, so a policy is had once an element. */
  private readonly _metas = new WeakSet<object>();
  /** Which of `e`, `w` the guards have been told of. */
  private _said = '';
  /** The violations already reported (`_report`). */
  private readonly _reported = new Set<string>();

  constructor(private readonly _seams: CspSeams<T>) {}

  /** The policies a response's headers carry. */
  addHeaders(headers: readonly (readonly [string, string])[]): void {
    this._add(policiesOfHeaders(headers));
  }

  /** Another document's, copied: what a local document inherits from the
   *  one that made it (CSP 3, 4.2.1; HTML's policy container). */
  inherit(from: PageCsp<unknown>): void {
    this._add(from.policies.map((p) => ({ ...p })));
    if (from.upgradeInherited) this.upgradeInherited = true;
  }

  /** A `<meta http-equiv="Content-Security-Policy">`'s, once (HTML 4.2.5.3,
   *  the "Content security policy" state): enforced, and with nothing of
   *  reports, framing or sandboxing in it. */
  addMeta(element: object, text: string): void {
    if (this._metas.has(element)) return;
    this._metas.add(element);
    this._add(parsePolicyList(text, 'enforce', 'meta'));
  }

  private _add(policies: CspPolicyEntry[]): void {
    if (!policies.length) return;
    this.policies.push(...policies);
    let said = this._said.includes('p') ? this._said : `${this._said}p`;
    for (const p of policies) {
      // a policy, enforced or reported, that requires Trusted Types of the
      // sinks that take script (Trusted Types, 4.4)
      if (
        !said.includes('t') &&
        p.directives.get('require-trusted-types-for')?.includes("'script'")
      ) {
        said += 't';
      }
      const list = directiveFor(p.directives, 'script-src');
      if (!list) continue;
      if (!said.includes('e') && !evalMatches(list, false)) said += 'e';
      if (!said.includes('w') && !evalMatches(list, true)) said += 'w';
    }
    if (said !== this._said) {
      this._said = said;
      this._seams.changed?.(said);
    }
  }

  /** What string compilation is held to, as `changed` says it. */
  get said(): string {
    return this._said;
  }

  /** Whether an enforced policy says `upgrade-insecure-requests` (Upgrade
   *  Insecure Requests, 3.1): a document's insecure requests are then sent
   *  as secure ones. A report-only policy says nothing of it. */
  get upgrades(): boolean {
    return (
      this.upgradeInherited ||
      this.policies.some(
        (p) =>
          p.disposition === 'enforce' &&
          p.directives.has('upgrade-insecure-requests'),
      )
    );
  }

  /** Whether the document that made this one upgrades its insecure
   *  requests, whatever this one's policies say: a frame's document, and a
   *  worker, keeps its creator's insecure requests policy (Upgrade Insecure
   *  Requests, 3.3; HTML, a worker's environment settings). */
  upgradeInherited = false;

  /** A URL as the document's request for it is sent (`upgradedUrl`), where
   *  its policies upgrade insecure requests, and as it is where not. */
  upgrade(url: string): string {
    return this.upgrades ? upgradedUrl(url) : url;
  }

  /**
   * The ancestors a document's `frame-ancestors` refuses, reported (CSP 3,
   * 4.2.5, "Should navigation response to navigation request of type in
   * target be blocked?"): each policy, enforced or reported, that names none
   * of an ancestor's origin tells its report-uri, the document's address
   * the blocked URI, and no page hears of it, since the document is never
   * shown. Whether an enforced one refused it.
   */
  refusedAncestors(ancestors: readonly string[], url: string): boolean {
    let refused = false;
    for (const policy of this.policies) {
      const list = policy.directives.get('frame-ancestors');
      if (!list) continue;
      const outside = ancestors.some(
        (a) => a === 'null' || !matchesSourceList(list, a, url),
      );
      if (!outside) continue;
      this._violate(policy, 'frame-ancestors', reportedUrl(url), '', null, {});
      if (policy.disposition === 'enforce') refused = true;
    }
    return refused;
  }

  /**
   * Whether a sink may take a string no policy made, telling a violation
   * where not (Trusted Types, "Does sink type require trusted types?" and
   * "Should sink type mismatch violation be blocked by Content Security
   * Policy?"): every policy that requires Trusted Types refuses it, and an
   * enforced one keeps it out. Its sample is the sink's name and the
   * string's first 40 characters.
   */
  allowsSink(sink: string, value: string): boolean {
    let allowed = true;
    for (const policy of this.policies) {
      const list = policy.directives.get('require-trusted-types-for');
      if (!list?.includes("'script'")) continue;
      this._violate(
        policy,
        'require-trusted-types-for',
        'trusted-types-sink',
        `${sink}|${value.slice(0, SAMPLE_LENGTH)}`,
        null,
        {},
      );
      if (policy.disposition === 'enforce') allowed = false;
    }
    return allowed;
  }

  /**
   * Whether a Trusted Types policy of a name may be made, telling a
   * violation where not (Trusted Types, "Should Trusted Type policy
   * creation be blocked by Content Security Policy?"): each policy with a
   * `trusted-types` directive names it, or says `*`, and a name made before
   * is made again only under `'allow-duplicates'`. Its sample is the name.
   */
  allowsPolicy(name: string, created: readonly string[]): boolean {
    let allowed = true;
    for (const policy of this.policies) {
      const list = policy.directives.get('trusted-types');
      if (!list) continue;
      const again =
        created.includes(name) && !list.includes("'allow-duplicates'");
      const named = list.includes('*') || list.includes(name);
      if (named && !again) continue;
      this._violate(
        policy,
        'trusted-types',
        'trusted-types-policy',
        name.slice(0, SAMPLE_LENGTH),
        null,
        {},
      );
      if (policy.disposition === 'enforce') allowed = false;
    }
    return allowed;
  }

  /** The enforced policies' directives, for what asks `connect-src` of
   *  them (`connectAllowed`). */
  enforced(): CspPolicy[] {
    return this.policies
      .filter((p) => p.disposition === 'enforce')
      .map((p) => p.directives);
  }

  /**
   * Whether a request may be made, or a response used, telling what refuses
   * it (CSP 3, 4.1.2 and 4.1.3): each URL it went through after the first,
   * as a redirect's is checked before it is followed, and the first. What a
   * violation reports is the URL first asked for (`blockedURI`), as a
   * browser reports one a redirect took somewhere it may not go.
   */
  request(
    request: CspRequest,
    target: T | null = null,
    through: readonly string[] = [],
    where: CspWhere = {},
  ): boolean {
    const effective = effectiveDirective(request.destination);
    if (!effective || !this.policies.length) return true;
    const self = this._seams.origin();
    let allowed = true;
    for (const policy of this.policies) {
      const list = directiveFor(policy.directives, effective);
      if (!list) continue;
      const refused = [request.url, ...through].some(
        (url) => !requestMatches(list, request, url, self, digest),
      );
      if (!refused) continue;
      this._violate(
        policy,
        effective,
        frameBlocked(effective, request.url, self) ?? reportedUrl(request.url),
        '',
        target,
        where,
      );
      if (policy.disposition === 'enforce') allowed = false;
    }
    return allowed;
  }

  /**
   * Whether inline content may run or apply (CSP 3, 4.2.3, "Should element's
   * inline type behavior be blocked?"): a `<script>`'s text, a `<style>`'s,
   * an `on…` attribute's, a `style` attribute's, a `javascript:` URL's.
   */
  inline(
    type: InlineType,
    source: string,
    nonce: string,
    target: T | null,
    where: CspWhere = {},
    /** A script a script put in, which `'strict-dynamic'` trusts. */
    dynamic = false,
  ): boolean {
    if (!this.policies.length) return true;
    const effective = inlineDirective(type);
    let allowed = true;
    for (const policy of this.policies) {
      const list = directiveFor(policy.directives, effective);
      if (!list) continue;
      if (inlineMatches(list, type, source, nonce, digest, dynamic)) continue;
      const sample = wantsSample(list) ? source.slice(0, SAMPLE_LENGTH) : '';
      this._violate(policy, effective, 'inline', sample, target, where);
      if (policy.disposition === 'enforce') allowed = false;
    }
    return allowed;
  }

  /** Whether a string may be compiled as script, or WebAssembly compiled
   *  (CSP 3, 4.4, "EnsureCSPDoesNotBlockStringCompilation", and 4.5). */
  compile(source: string | null, where: CspWhere = {}): boolean {
    if (!this.policies.length) return true;
    const wasm = source === null;
    let allowed = true;
    for (const policy of this.policies) {
      const list = directiveFor(policy.directives, 'script-src');
      if (!list || evalMatches(list, wasm, source ?? undefined, digest)) {
        continue;
      }
      const sample =
        !wasm && wantsSample(list)
          ? (source ?? '').slice(0, SAMPLE_LENGTH)
          : '';
      this._violate(
        policy,
        'script-src',
        wasm ? 'wasm-eval' : 'eval',
        sample,
        null,
        where,
      );
      if (policy.disposition === 'enforce') allowed = false;
    }
    return allowed;
  }

  /** Whether a navigation a form submits, or a base URL, may be had
   *  (`form-action`, `base-uri`), which fall back to nothing. */
  allowsUrl(
    directive: 'form-action' | 'base-uri',
    url: string,
    target: T | null = null,
    where: CspWhere = {},
  ): boolean {
    if (!this.policies.length) return true;
    const self = this._seams.origin();
    let allowed = true;
    for (const policy of this.policies) {
      const list = policy.directives.get(directive);
      if (!list || matchesSourceList(list, url, self)) continue;
      this._violate(policy, directive, reportedUrl(url), '', target, where);
      if (policy.disposition === 'enforce') allowed = false;
    }
    return allowed;
  }

  /** A violation told and reported (CSP 3, 5.3). */
  private _violate(
    policy: CspPolicyEntry,
    effective: string,
    blockedURI: string,
    sample: string,
    target: T | null,
    said: CspWhere,
  ): void {
    // a place in the document is an inline violation's: one of a URL is
    // where the running script asked for it, or nowhere, line 0, as a
    // `<script src>` the parser met is reported by its URL alone (WPT's
    // `nonce-enforce-blocked`)
    const where =
      said.lineNumber === undefined
        ? (this._seams.where?.(blockedURI === 'inline' ? target : null) ?? said)
        : said;
    const documentURI = reportedUrl(this._seams.url());
    const violation: CspViolation = {
      documentURI,
      referrer: this._seams.referrer(),
      blockedURI,
      effectiveDirective: effective,
      violatedDirective: effective,
      originalPolicy: policy.text,
      sourceFile: where.sourceFile ? reportedUrl(where.sourceFile) : '',
      sample,
      disposition: policy.disposition,
      statusCode: this._seams.status(),
      lineNumber: where.lineNumber ?? 0,
      columnNumber: where.columnNumber ?? 0,
    };
    this._seams.tell(violation, target);
    this._report(policy, violation);
  }

  /** A report sent where the policy says (CSP 3, 5.3, steps 3 and 4): to a
   *  `report-to` group's endpoint, as the Reporting API's, where the
   *  response names one, else to each `report-uri`, as CSP 2's. */
  private _report(policy: CspPolicyEntry, v: CspViolation): void {
    // one report for each distinct violation of a document's, as browsers
    // send them: the same refusal at the same place, five times in a loop,
    // is one (WPT's `report-multiple-violations-02`)
    const key = JSON.stringify([policy.text, policy.disposition, v]);
    if (this._reported.has(key)) return;
    this._reported.add(key);
    const group = policy.directives.get('report-to')?.[0];
    const endpoint = group ? (this._seams.endpoint?.(group) ?? null) : null;
    if (endpoint) {
      this._seams.send(
        endpoint,
        JSON.stringify([
          {
            type: 'csp-violation',
            age: 0,
            url: v.documentURI,
            user_agent: '',
            body: {
              documentURL: v.documentURI,
              referrer: v.referrer || null,
              blockedURL: v.blockedURI || null,
              effectiveDirective: v.effectiveDirective,
              originalPolicy: v.originalPolicy,
              sourceFile: v.sourceFile || null,
              sample: v.sample || null,
              disposition: v.disposition,
              statusCode: v.statusCode,
              lineNumber: v.lineNumber || null,
              columnNumber: v.columnNumber || null,
            },
          },
        ]),
        'application/reports+json',
      );
      return;
    }
    const uris = policy.directives.get('report-uri');
    if (!uris || policy.source === 'meta') return;
    const body = JSON.stringify({
      'csp-report': {
        'document-uri': v.documentURI,
        referrer: v.referrer,
        'violated-directive': v.effectiveDirective,
        'effective-directive': v.effectiveDirective,
        'original-policy': v.originalPolicy,
        disposition: v.disposition,
        'blocked-uri': v.blockedURI,
        'line-number': v.lineNumber,
        'column-number': v.columnNumber,
        'source-file': v.sourceFile,
        'status-code': v.statusCode,
        'script-sample': v.sample,
      },
    });
    for (const uri of uris) {
      let url: string;
      try {
        url = new URL(uri, this._seams.url()).href;
      } catch {
        continue;
      }
      this._seams.send(url, body, 'application/csp-report');
    }
  }
}

declare const URL: new (
  url: string,
  base?: string,
) => { href: string; origin: string };

/** Where a `report-to` group sends (Reporting API): a response's
 *  `Reporting-Endpoints`, `group="url"` a member, and its `Report-To`, a
 *  JSON object a group. */
export function reportEndpointsOf(
  headers: readonly (readonly [string, string])[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (key === 'reporting-endpoints') {
      for (const m of value.matchAll(/([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/g)) {
        if (!out.has(m[1])) out.set(m[1], m[2]);
      }
    } else if (key === 'report-to') {
      for (const piece of value.split(/(?<=\})\s*,\s*(?=\{)/)) {
        try {
          const group = JSON.parse(piece) as {
            group?: string;
            endpoints?: { url?: string }[];
          };
          const at = group.endpoints?.[0]?.url;
          const nameOf = group.group ?? 'default';
          if (at && !out.has(nameOf)) out.set(nameOf, at);
        } catch {
          // not a group
        }
      }
    }
  }
  return out;
}
