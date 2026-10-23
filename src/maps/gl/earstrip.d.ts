// The slice of earstrip 0.2 that `buckets.ts` calls, reached as `#earstrip`
// (package.json's `imports`): TypeScript reads this through the `types`
// condition, and Node, tsx and esbuild load the package itself. The
// package's own `earstrip.d.ts` has an extensionless relative `import()`,
// which `nodenext` rejects and `skipLibCheck: false` reports
// (GLMap/earstrip#1). When a release fixes it, delete this file, drop the
// `imports` entry and import `earstrip` directly.

/**
 * Many polygons in one call. Polygon `k` is the vertices
 * `[polygonStarts[k], polygonStarts[k + 1])` of `data`, its holes starting
 * at `holeIndices[holeStarts[k] .. holeStarts[k + 1])`, counted from its own
 * first vertex. Answers counter-clockwise triangles, three indices each,
 * counted from the first vertex of `data` and never a point of its own;
 * polygon `k`'s are `indices[offsets[k] .. offsets[k + 1])`.
 */
export declare function batch(
  data: ArrayLike<number>,
  polygonStarts: ArrayLike<number>,
  holeIndices?: ArrayLike<number> | null,
  holeStarts?: ArrayLike<number> | null,
  dim?: number,
): { indices: Uint32Array<ArrayBuffer>; offsets: Uint32Array<ArrayBuffer> };
