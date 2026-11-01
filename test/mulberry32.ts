// A seeded generator for what a test makes up: the same numbers for the same
// seed on every machine, and all 2^32 of them before it comes round again.
//
// mulberry32, as `scripts/conformance/fuzz.ts` has it. Not
// `seed * 1103515245 + 12345`, which is a generator on 64-bit integers and
// none on a double: the product is past 2^53, so it loses its low bits, and
// what is left falls into a cycle — 10,466 numbers from nearly every seed, and
// 220 from a few. A test that asks for more is handed the same numbers again
// and says nothing of it: a sweep of 300 seeds that drew 130 numbers a case
// was 79 cases, and the case it could not reach was a real bug.
//
// Not a `.test.ts` file, so `tsx --test test/*.test.ts` does not run it, but
// `tsconfig.json` does typecheck it.

/** Numbers in [0, 1) from `seed`, of which the low 32 bits are all that count. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
