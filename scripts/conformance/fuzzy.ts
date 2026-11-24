/**
 * What a test's `<meta name=fuzzy content="maxDifference=a-b;totalPixels=c-d">`
 * allows: the upper bounds of both. With a reference named
 * (`content="ref.html:…"`), only for that one, where the caller says
 * which reference it is comparing with. The two runners
 * (`wpt.tsx`, `testharness.tsx`) read it the same way.
 *
 * An attribute's quotes are optional, as they are to WPT's own reader. A
 * name read only quoted dropped the annotation of every test that wrote
 * `name=fuzzy`, and judged each as allowing no difference at all
 * (css-images/gradient/gradient-powerless-hue-lch among them).
 */
export function fuzzyOf(
  source: string,
  refName?: string,
): { maxDifference: number; totalPixels: number } {
  let allowed = { maxDifference: 0, totalPixels: 0 };
  for (const tag of source.match(
    /<(?:[\w.-]+:)?meta\b[^>]*\bname\s*=\s*(?:"fuzzy"|'fuzzy'|fuzzy(?=[\s/>]))[^>]*>/gi,
  ) ?? []) {
    const value = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(
      tag,
    );
    const content = value?.[1] ?? value?.[2] ?? value?.[3];
    if (!content) continue;
    let spec = content;
    const named = /^([^:;=]+):(.*)$/.exec(content);
    if (named && !/=/.test(named[1])) {
      if (refName !== undefined && !refName.endsWith(named[1].trim())) {
        continue;
      }
      spec = named[2];
    }
    const parts = spec.split(';').map((p) => p.trim());
    const upper = (s: string | undefined) => {
      const m = /(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(s ?? '');
      return m ? Number(m[2] ?? m[1]) : 0;
    };
    const byName = (name: string, index: number) =>
      parts.find((p) => p.startsWith(name + '=')) ?? parts[index];
    allowed = {
      maxDifference: upper(byName('maxDifference', 0)?.replace(/^.*=/, '')),
      totalPixels: upper(byName('totalPixels', 1)?.replace(/^.*=/, '')),
    };
  }
  return allowed;
}
