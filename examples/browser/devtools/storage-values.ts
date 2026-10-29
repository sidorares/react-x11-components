// What IndexedDB keeps, read back for showing: the page's realm keeps a
// record's key and value as text in its own encodings (`keyForm` and
// `serializeClone` in `src/html/scripts/dom.ts`), and the Storage panel
// shows them as the values they were — a number key as the number, an
// object as an object a tree opens — rather than as that text.

/** A key, from `["n", 1]`, `["s", "a"]`, `["d", ms]`, `["a", [...]]`. */
export function decodeKey(text: string): unknown {
  const form = (f: unknown): unknown => {
    if (!Array.isArray(f)) return f;
    switch (f[0]) {
      case 'n':
        return typeof f[1] === 'string' ? Number(f[1]) : f[1];
      case 's':
        return f[1];
      case 'd':
        return new Date(f[1] as number).toISOString();
      case 'a':
        return (f[1] as unknown[]).map(form);
      default:
        return `(${String(f[1]).length} bytes)`;
    }
  };
  try {
    return form(JSON.parse(text));
  } catch {
    return text;
  }
}

/** A value, from the realm's structured clone: objects, arrays, maps,
 *  sets, dates and the like as plain values JSON can show, what it cannot
 *  show — a blob, a view of bytes — as a word about it. */
export function decodeValue(text: string): unknown {
  const seen = new Map<number, unknown>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    const node = v as Record<string, unknown>;
    if ('u' in node) return undefined;
    if ('n' in node && Object.keys(node).length === 1) return Number(node.n);
    if ('g' in node) return `${node.g}n`;
    if ('r' in node) return seen.get(node.r as number) ?? '(cycle)';
    const index = node.i as number;
    const entries = (node.e ?? []) as unknown[];
    let out: unknown;
    switch (node.t) {
      case 'O': {
        const o: Record<string, unknown> = {};
        seen.set(index, o);
        for (const [k, x] of entries as [string, unknown][]) o[k] = walk(x);
        out = o;
        break;
      }
      case 'A': {
        const a: unknown[] = [];
        seen.set(index, a);
        for (const [k, x] of entries as [string, unknown][])
          a[Number(k)] = walk(x);
        out = a;
        break;
      }
      case 'M':
        out = Object.fromEntries(
          (entries as [unknown, unknown][]).map(([k, x]) => [
            String(walk(k)),
            walk(x),
          ]),
        );
        break;
      case 'S':
        out = (entries as unknown[]).map(walk);
        break;
      case 'D':
        out = new Date(node.v as number).toISOString();
        break;
      case 'R':
        out = `/${node.s}/${node.f}`;
        break;
      case 'P':
        out = walk(node.v);
        break;
      case 'E':
        out = `${node.n}: ${node.m}`;
        break;
      default:
        out = `(${node.t === 'L' ? 'a Blob' : node.t === 'B' || node.t === 'V' ? 'bytes' : 'an object'})`;
    }
    if (index !== undefined && !seen.has(index)) seen.set(index, out);
    return out;
  };
  try {
    return walk(JSON.parse(text));
  } catch {
    return text;
  }
}
