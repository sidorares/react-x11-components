// What a page's scripts look for on `Math` that a runtime may not have yet:
// `Math.sumPrecise` (ES2026), which pdf.js's font compiler calls, so that
// every font a document embedded threw and it was set in what the machine
// had. Node has none yet and Bun 1.4 has its own, which is left where it is.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the engine
// hands it to the context through `Function.prototype.toString()`, so it
// closes over nothing. It runs in every realm the engine makes, a page's, a
// frame's and a worker's, before `installDom` and so before any page code:
// what the sum calls as it runs it takes here, since a page may replace
// `Number` or `BigInt.prototype.toString` as it likes. `installDom`'s walk
// marks it as native, so `toString()` answers as a builtin's does.

export function installMath(): void {
  'use strict';
  type Any = any;
  if ((Math as Any).sumPrecise) return;

  const { apply } = Reflect;
  const bigint = BigInt;
  const number = Number;
  const digits = BigInt.prototype.toString;
  const NotANumber = TypeError;
  const double = new Float64Array(1);
  const bits = new BigUint64Array(double.buffer);

  Object.defineProperty(Math, 'sumPrecise', {
    writable: true,
    configurable: true,
    // a method, so that it is no constructor and has no `prototype`
    value: {
      sumPrecise(items: Any): number {
        // A finite double is a whole number of 2^-1074, so the sum is a
        // BigInt of those, and is rounded once
        let sum = 0n;
        let negativeZero = true;
        let nan = false;
        let up = false;
        let down = false;
        // `for…of` is the specification's iteration: `items` is asked for its
        // iterator as it is written, and what is thrown here closes it
        for (const item of items) {
          if (typeof item !== 'number') {
            throw new NotANumber('Math.sumPrecise adds numbers');
          }
          if (item !== item) nan = true;
          else if (item === Infinity) up = true;
          else if (item === -Infinity) down = true;
          else if (item !== 0 || 1 / item > 0) {
            negativeZero = false;
            double[0] = item;
            const word = bits[0];
            const exponent = number((word >> 52n) & 0x7ffn);
            const fraction = word & 0xfffffffffffffn;
            const units = exponent
              ? (fraction | (1n << 52n)) << bigint(exponent - 1)
              : fraction;
            sum += word >> 63n ? -units : units;
          }
        }
        if (nan || (up && down)) return NaN;
        if (up) return Infinity;
        if (down) return -Infinity;
        if (negativeZero) return -0;
        const size = sum < 0n ? -sum : sum;
        // 55 bits, the last of them set if anything is cut off below, which
        // is all that rounding to 53 reads
        const length = apply(digits, size, [2]).length;
        const cut = length > 55 ? length - 55 : 0;
        let kept = size >> bigint(cut);
        if (kept << bigint(cut) !== size) kept |= 1n;
        return (sum < 0n ? -1 : 1) * number(kept) * 2 ** (cut - 1074);
      },
    }.sumPrecise,
  });
}
