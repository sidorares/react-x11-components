// A document's sandboxing flags (HTML 7.1.?, "sandboxing flag sets"): what an
// `<iframe sandbox>` or a policy's `sandbox` directive takes away from it, kept
// by the document on the host (`DomShared.sandboxes`), where no page can reach
// them. A flag set is a restriction, and each `allow-*` token lifts its own, so
// what a frame inherits from the document around it is added to what it asks
// for and no token takes it back.
//
// Pure, and asked by the host alone.

/** Every value of a header, as one list: `Headers` joins them with commas,
 *  and a host's own network may not. */
export function headerList(
  headers: [string, string][],
  name: string,
): string | null {
  const found = headers.filter(([k]) => k.toLowerCase() === name);
  return found.length ? found.map(([, v]) => v).join(',') : null;
}

/** Navigating any window but this one and those under it. */
export const SB_NAVIGATION = 1 << 0;
/** Opening a window (`allow-popups`). */
export const SB_POPUPS = 1 << 1;
/** Navigating the top window with no gesture (`allow-top-navigation`). */
export const SB_TOP = 1 << 2;
/** Navigating it with one (`allow-top-navigation-by-user-activation`). */
export const SB_TOP_GESTURE = 1 << 3;
/** An opaque origin, whatever its address (`allow-same-origin`). */
export const SB_ORIGIN = 1 << 4;
/** Submitting a form (`allow-forms`). */
export const SB_FORMS = 1 << 5;
/** Running a script (`allow-scripts`). */
export const SB_SCRIPTS = 1 << 6;
/** What happens by itself: `autofocus`, autoplay (`allow-scripts`). */
export const SB_AUTOMATIC = 1 << 7;
/** A window it opens is sandboxed too (`allow-popups-to-escape-sandbox`). */
export const SB_PROPAGATES = 1 << 8;
/** `alert` and its kin (`allow-modals`). */
export const SB_MODALS = 1 << 9;
/** Saving a file (`allow-downloads`). */
export const SB_DOWNLOADS = 1 << 10;

/** Every restriction, which a `sandbox` of no tokens is. */
export const SB_ALL = (1 << 11) - 1;

const LIFTS: Record<string, number> = {
  'allow-popups': SB_POPUPS,
  'allow-top-navigation': SB_TOP | SB_TOP_GESTURE,
  'allow-top-navigation-by-user-activation': SB_TOP_GESTURE,
  'allow-same-origin': SB_ORIGIN,
  'allow-forms': SB_FORMS,
  'allow-scripts': SB_SCRIPTS | SB_AUTOMATIC,
  'allow-popups-to-escape-sandbox': SB_PROPAGATES,
  'allow-modals': SB_MODALS,
  'allow-downloads': SB_DOWNLOADS,
};

/** The flags a list of tokens sets (HTML 7.1.?, "parse a sandboxing
 *  directive"): ASCII case-insensitive, and what it does not know is nothing. */
export function parseSandbox(value: string): number {
  let flags = SB_ALL;
  for (const token of value.split(/[\t\n\f\r ]+/)) {
    flags &= ~(LIFTS[token.toLowerCase()] ?? 0);
  }
  return flags;
}

/**
 * The flags a response's own policies set, its `sandbox` directives
 * (CSP 3, 6.3.2): one header may hold several policies, and each that has one
 * adds to the rest. `Content-Security-Policy-Report-Only` enforces nothing.
 */
export function sandboxOfPolicy(headers: [string, string][]): number {
  let flags = 0;
  const text = headerList(headers, 'content-security-policy');
  for (const policy of (text ?? '').split(',')) {
    for (const directive of policy.split(';')) {
      const [name, ...tokens] = directive.trim().split(/[\t\n\f\r ]+/);
      if (name.toLowerCase() === 'sandbox') {
        flags |= parseSandbox(tokens.join(' '));
      }
    }
  }
  return flags;
}
