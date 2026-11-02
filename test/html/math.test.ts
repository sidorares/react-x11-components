// `Math.sumPrecise` (src/html/scripts/math.ts): the proposal's cases, and
// generated lists held to the exact sum in `BigInt`. Each runs in a context
// with the runtime's own taken away first, so this is the package's sum on
// Bun, which has one, as on Node, which has none. That the realms have it is
// in `scripts.test.ts`, which also has its answers in a page and a worker.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { installMath } from '../../src/html/scripts/math.js';
import { mulberry32 } from '../mulberry32.js';

/** How many lists each generator makes. A sweep sets it higher. */
const SEEDS = Number(process.env.SUM_SEEDS ?? 3000);

/** tsx keeps a function's name with a helper the engine's `INSTALL` defines. */
const INSTALL = `const __name = (target) => target; (${installMath.toString()})();`;

function realm(): vm.Context {
  const context = vm.createContext({});
  vm.runInContext('delete Math.sumPrecise', context);
  vm.runInContext(INSTALL, context);
  return context;
}

const REALM = realm();
const inRealm = (code: string): unknown => vm.runInContext(code, REALM);
const sum = inRealm('Math.sumPrecise') as (items: Iterable<number>) => number;

const MAX = Number.MAX_VALUE;
const LEAST = Number.MIN_VALUE;
/** The top double's last place, half of which is the way to an infinity. */
const TOP_PLACE = 2 ** 971;

const same = (actual: number, expected: number, note?: string): void =>
  assert.ok(
    Object.is(actual, expected),
    `${note ?? ''} got ${actual}, wanted ${expected}`,
  );

// --- the exact sum ----------------------------------------------------------

const word = new DataView(new ArrayBuffer(8));
const bitsOf = (x: number): bigint => {
  word.setFloat64(0, x);
  return word.getBigUint64(0);
};
const doubleOf = (bits: bigint): number => {
  word.setBigUint64(0, bits);
  return word.getFloat64(0);
};

/** A finite double as a whole number of 2^-1074. */
function units(x: number): bigint {
  const bits = bitsOf(x);
  const exponent = (bits >> 52n) & 0x7ffn;
  const fraction = bits & ((1n << 52n) - 1n);
  const size =
    exponent === 0n ? fraction : (fraction | (1n << 52n)) << (exponent - 1n);
  return bits >> 63n ? -size : size;
}

/** 2^1024, which no double reaches, as the next one past the top. */
const PAST_TOP = 1n << 2098n;

/** Why `result` is no nearest double to `exact` units, or null if it is: no
 *  double is closer, and of two as close it is the one that ends in a 0. This
 *  asks that of the neighbours, so it shares no arithmetic with the sum. */
function wrong(result: number, exact: bigint): string | null {
  const negative = exact < 0n;
  const size = negative ? -exact : exact;
  if (result !== result) return 'NaN';
  if (exact === 0n) return result === 0 ? null : 'no zero';
  if (result === 0 || result < 0 !== negative) return 'the wrong sign';
  if (result === Infinity || result === -Infinity) {
    // past half way from the top double to 2^1024, or on it, since the top
    // double ends in a 1
    return size * 2n >= PAST_TOP + units(MAX) ? null : 'an early infinity';
  }
  const held = negative ? -result : result;
  const bits = bitsOf(held);
  const here = units(held);
  const above = doubleOf(bits + 1n);
  const neighbours = [
    above === Infinity ? PAST_TOP : units(above),
    bits > 0n ? units(doubleOf(bits - 1n)) : 0n,
  ];
  const off = (at: bigint): bigint => (at > size ? at - size : size - at);
  for (const neighbour of neighbours) {
    if (off(neighbour) < off(here)) return 'a closer double';
    if (off(neighbour) === off(here) && bits & 1n) return 'an odd tie';
  }
  return null;
}

function holds(list: number[], note: string): void {
  let exact = 0n;
  for (const n of list) exact += units(n);
  const result = sum(list);
  const why = wrong(result, exact);
  assert.equal(
    why,
    null,
    `${note}: ${why} from [${list.join(', ')}], which came to ${result}`,
  );
}

// --- the proposal's cases ---------------------------------------------------

test('a sum is exact, where a float accumulator is not', () => {
  same(sum([1e20, 0.1, -1e20]), 0.1);
  same(sum([1e30, 0.1, -1e30]), 0.1);
  same(sum([1, 1e100, 1, -1e100]), 2);
  same(sum([0.1, 0.2]), 0.30000000000000004);
  same(sum([0.1, 0.1, 0.1, -0.1, -0.1, -0.1]), 0);
  same(sum([1, 2, 3]), 6);
  // what the naive sum of these comes to, for the record of why it is wrong
  assert.notEqual(1e20 + 0.1 - 1e20, 0.1);
});

test('nothing adds up to -0, and only -0s do', () => {
  same(sum([]), -0);
  same(sum([-0]), -0);
  same(sum([-0, -0, -0]), -0);
  same(sum([0]), 0);
  same(sum([-0, 0]), 0);
  same(sum([0, -0]), 0);
  // a sum that cancels is a finite sum, and that is +0 whichever came first
  same(sum([1, -1]), 0);
  same(sum([-1, 1]), 0);
  same(sum([-1, -0, 1]), 0);
});

test('NaN and the infinities are as the proposal has them', () => {
  same(sum([NaN]), NaN);
  same(sum([1, NaN, 2]), NaN);
  same(sum([Infinity, -Infinity]), NaN);
  same(sum([-Infinity, 1, Infinity]), NaN);
  same(sum([Infinity, NaN]), NaN);
  same(sum([NaN, Infinity]), NaN);
  same(sum([Infinity]), Infinity);
  same(sum([Infinity, Infinity]), Infinity);
  same(sum([-Infinity, -Infinity]), -Infinity);
  same(sum([Infinity, -MAX, -MAX, -MAX]), Infinity);
  same(sum([-Infinity, MAX, MAX, MAX]), -Infinity);
  same(sum([MAX, Infinity, MAX]), Infinity);
});

test('a sum that overflows on its way is not an infinity at its end', () => {
  same(sum([MAX, MAX, -MAX]), MAX);
  same(sum([-MAX, -MAX, MAX]), -MAX);
  same(sum([MAX, MAX, -MAX, -MAX]), 0);
  same(sum([MAX, MAX, MAX, -MAX, -MAX, 1, -MAX]), 1);
  same(sum(Array.from({ length: 2000 }, (_, i) => (i < 1000 ? MAX : -MAX))), 0);
  // and one that ends past the top is
  same(sum([MAX, MAX]), Infinity);
  same(sum([-MAX, -MAX]), -Infinity);
});

test('the way to an infinity is rounded as a Number value is', () => {
  // half a place past the top double is a tie, and the top double ends in a 1
  same(sum([MAX, TOP_PLACE / 2]), Infinity);
  same(sum([-MAX, -TOP_PLACE / 2]), -Infinity);
  // the least thing under that is not
  same(sum([MAX, TOP_PLACE / 2, -LEAST]), MAX);
  same(sum([-MAX, -TOP_PLACE / 2, LEAST]), -MAX);
  same(sum([MAX, TOP_PLACE / 2, LEAST]), Infinity);
  same(sum([MAX, TOP_PLACE]), Infinity);
  same(sum([MAX, TOP_PLACE, -TOP_PLACE]), MAX);
});

test('a tie goes to the even double, and anything past it does not', () => {
  const two53 = 2 ** 53;
  same(sum([two53, 1]), two53);
  same(sum([two53 + 2, 1]), two53 + 4);
  same(sum([two53, 1, LEAST]), two53 + 2);
  same(sum([two53 + 2, 1, -LEAST]), two53 + 2);
  same(sum([-two53, -1]), -two53);
  same(sum([-two53 - 2, -1]), -two53 - 4);
  // with the bit that breaks it a long way under the tie, past a whole digit
  same(sum([two53, 1, 2 ** -1000]), two53 + 2);
  same(sum([1, 2 ** -53]), 1);
  same(sum([1, 2 ** -53, LEAST]), 1 + 2 ** -52);
});

test('a subnormal sum is exact, and comes to a normal number as it should', () => {
  same(sum([LEAST, LEAST]), 2 * LEAST);
  same(sum([LEAST, -LEAST]), 0);
  const leastNormal = 2 ** -1022;
  same(sum([leastNormal - LEAST, LEAST]), leastNormal);
  same(sum([leastNormal, -LEAST]), leastNormal - LEAST);
  same(sum([2 ** -1073, -LEAST]), LEAST);
});

// --- what it takes ----------------------------------------------------------

test('it takes any iterable, and only one', () => {
  same(sum(new Set([1, 2])), 3);
  same(sum(new Float64Array([0.5, 0.25])), 0.75);
  same(
    inRealm(
      'Math.sumPrecise((function* () { yield 1; yield 2; yield 3; })())',
    ) as number,
    6,
  );
  for (const code of [
    'Math.sumPrecise()',
    'Math.sumPrecise(null)',
    'Math.sumPrecise(1)',
    'Math.sumPrecise({})',
    'Math.sumPrecise({ length: 1, 0: 1 })',
  ]) {
    assert.equal(
      inRealm(`try { ${code}; 'no' } catch (e) { e.name }`),
      'TypeError',
      code,
    );
  }
});

test('an array is read through its iterator, whoever replaced it', () => {
  const context = realm();
  assert.equal(
    vm.runInContext(
      `const own = Array.prototype[Symbol.iterator];
       Array.prototype[Symbol.iterator] = function* () { yield 40; yield 2; };
       const out = Math.sumPrecise([1, 2, 3]);
       Array.prototype[Symbol.iterator] = own;
       out`,
      context,
    ),
    42,
  );
});

test('what is no Number is a TypeError, not coerced, and closes the iterator', () => {
  const context = realm();
  vm.runInContext(
    `var closed = 0, valueOf = 0, after = 0;
     var list = (head, returns) => ({
       [Symbol.iterator]() {
         let i = 0;
         return {
           next: () => (i < head.length ? { value: head[i++], done: false } : (after++, { done: true })),
           return: returns ?? (() => (closed++, {})),
         };
       },
     });`,
    context,
  );
  for (const code of [
    '"1"',
    '1n',
    'null',
    'undefined',
    'true',
    'Symbol.iterator',
    '{}',
    '[]',
    'new Number(1)',
    '({ valueOf() { valueOf++; return 1; } })',
  ]) {
    const name = vm.runInContext(
      `closed = 0;
       try { Math.sumPrecise(list([1, ${code}, 2])); 'no' }
       catch (e) { e instanceof TypeError ? 'TypeError' : e.name }`,
      context,
    );
    assert.equal(name, 'TypeError', code);
    assert.equal(vm.runInContext('closed', context), 1, `${code} closes`);
  }
  assert.equal(vm.runInContext('valueOf', context), 0);
  assert.equal(vm.runInContext('after', context), 0, 'nothing read past it');
  // a sum already NaN or infinite still reads what comes after
  for (const head of ['NaN', 'Infinity', '-Infinity']) {
    assert.equal(
      vm.runInContext(
        `try { Math.sumPrecise(list([${head}, "1"])); 'no' } catch (e) { e.name }`,
        context,
      ),
      'TypeError',
      head,
    );
  }
  // and the error is the sum's, whatever `return` does
  assert.equal(
    vm.runInContext(
      `try { Math.sumPrecise(list(["1"], () => { throw new RangeError('return'); })); 'no' }
       catch (e) { e.name }`,
      context,
    ),
    'TypeError',
  );
});

test('what an iterator throws is thrown, and it is not closed for it', () => {
  const context = realm();
  assert.equal(
    vm.runInContext(
      `var closed = 0;
       const items = {
         [Symbol.iterator]: () => ({
           next() { throw new RangeError('next'); },
           return() { closed++; return {}; },
         }),
       };
       let name;
       try { Math.sumPrecise(items); } catch (e) { name = e.name; }
       name + ' ' + closed`,
      context,
    ),
    'RangeError 0',
  );
});

test('an iterator may add something up itself on the way', () => {
  assert.equal(
    inRealm(
      `Math.sumPrecise((function* () {
         yield 1e20;
         yield Math.sumPrecise([1e30, 0.5, -1e30]);
         yield -1e20;
       })())`,
    ),
    0.5,
  );
});

test('it is a builtin as a page reads one', () => {
  const descriptor = inRealm(
    `JSON.stringify(Object.getOwnPropertyDescriptor(Math, 'sumPrecise'))`,
  );
  assert.deepEqual(JSON.parse(descriptor as string), {
    writable: true,
    enumerable: false,
    configurable: true,
  });
  assert.equal(inRealm('Math.sumPrecise.length'), 1);
  assert.equal(inRealm('Math.sumPrecise.name'), 'sumPrecise');
  assert.equal(inRealm(`'prototype' in Math.sumPrecise`), false);
  assert.equal(inRealm(`Object.keys(Math).includes('sumPrecise')`), false);
  assert.equal(
    inRealm(`try { new Math.sumPrecise([]); 'no' } catch (e) { e.name }`),
    'TypeError',
  );
});

test('a runtime that has its own keeps it', () => {
  const context = vm.createContext({});
  vm.runInContext(
    `Math.sumPrecise = function own() { return 'own'; };`,
    context,
  );
  vm.runInContext(INSTALL, context);
  assert.equal(vm.runInContext('Math.sumPrecise([1])', context), 'own');
});

test('what a page replaces is nothing to the sum', () => {
  const context = realm();
  assert.equal(
    vm.runInContext(
      `const real = TypeError;
       BigInt.prototype.toString = () => 'x';
       Reflect.apply = () => { throw 'replaced'; };
       Math.max = () => NaN;
       Number = () => NaN;
       BigInt = () => { throw 'replaced'; };
       TypeError = function () { throw 'replaced'; };
       let name;
       try { Math.sumPrecise(['1']); } catch (e) { name = e instanceof real; }
       Math.sumPrecise([1e20, 0.1, -1e20]) + ' ' + name`,
      context,
    ),
    '0.1 true',
  );
});

// --- generated lists --------------------------------------------------------

/** A finite double of any size: a double's bits at random. */
function anyDouble(next: () => number): number {
  for (;;) {
    const bits =
      (BigInt(Math.floor(next() * 2 ** 32)) << 32n) |
      BigInt(Math.floor(next() * 2 ** 32));
    const x = doubleOf(bits);
    if (Number.isFinite(x)) return x;
  }
}

const signed = (next: () => number, x: number): number =>
  next() < 0.5 ? x : -x;

/** A double whose binary exponent is near `exponent`, its fraction at random. */
function near(next: () => number, exponent: number, spread: number): number {
  const place = exponent + Math.floor(next() * spread);
  const biased = BigInt(Math.max(1, Math.min(2046, place + 1023)));
  const fraction =
    (BigInt(Math.floor(next() * 2 ** 20)) << 32n) |
    BigInt(Math.floor(next() * 2 ** 32));
  return signed(next, doubleOf((biased << 52n) | fraction));
}

function shuffled(next: () => number, list: number[]): number[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  return list;
}

/** A place of `x`: a power of two no greater than `x`'s last bit. */
const placeOf = (x: number): number => {
  const held = Math.abs(x);
  const above = doubleOf(bitsOf(held) + 1n);
  return (above === Infinity ? TOP_PLACE : above - held) || LEAST;
};

const GENERATORS: Record<string, (next: () => number) => number[]> = {
  // any size at all, where the largest usually decides
  any(next) {
    return Array.from({ length: 1 + Math.floor(next() * 40) }, () =>
      anyDouble(next),
    );
  },
  // one size, so that everything counts
  band(next) {
    const exponent = Math.floor(next() * 2000) - 1000;
    return Array.from({ length: 2 + Math.floor(next() * 60) }, () =>
      near(next, exponent, 8),
    );
  },
  // sizes across the whole range of a double's bits, spread over the digits
  spread(next) {
    const low = Math.floor(next() * 1900) - 1000;
    return Array.from({ length: 2 + Math.floor(next() * 40) }, () =>
      near(next, low, 150),
    );
  },
  // everything cancels but what is left, which is all the answer holds
  cancelling(next) {
    const list = Array.from({ length: 1 + Math.floor(next() * 30) }, () =>
      anyDouble(next),
    );
    const left = near(next, Math.floor(next() * 200) - 100, 4);
    return shuffled(next, [...list, ...list.map((n) => -n), left]);
  },
  // on a tie, and either side of it by a very little
  ties(next) {
    const x = near(next, Math.floor(next() * 2000) - 1000, 4);
    const half = placeOf(x) / 2;
    const list = half ? [x, Math.sign(x) * half] : [x];
    const nudge = next();
    if (nudge < 0.33) list.push(LEAST);
    else if (nudge < 0.66) list.push(-LEAST);
    if (next() < 0.5) list.push(placeOf(x) * 4, -placeOf(x) * 4);
    return shuffled(next, list);
  },
  // around the top of the range, with what brings it back
  top(next) {
    const list: number[] = [];
    const count = 2 + Math.floor(next() * 10);
    for (let i = 0; i < count; i++) {
      list.push(
        next() < 0.6
          ? signed(next, MAX - next() * TOP_PLACE * 4)
          : near(next, 1000, 24),
      );
    }
    if (next() < 0.5) list.push(signed(next, TOP_PLACE / 2));
    return shuffled(next, list);
  },
  // under the normal numbers, and across into them
  subnormal(next) {
    return Array.from({ length: 2 + Math.floor(next() * 40) }, () =>
      signed(
        next,
        next() < 0.8 ? Math.floor(next() * 2 ** 53) * LEAST : 2 ** -1022,
      ),
    );
  },
};

for (const [seed, [name, make]] of Object.entries(GENERATORS).entries()) {
  test(`a generated list comes to the double nearest its exact sum: ${name}`, () => {
    const next = mulberry32(seed + 1);
    for (let i = 0; i < SEEDS; i++) holds(make(next), `${name} ${i}`);
  });
}

test('any double alone comes to itself', () => {
  const next = mulberry32(1);
  for (let i = 0; i < SEEDS; i++) {
    const x = anyDouble(next);
    same(sum([x]), x);
  }
  for (let exponent = -1074; exponent < 1024; exponent++) {
    const x = 2 ** exponent;
    same(sum([x]), x, `2^${exponent}`);
    same(sum([-x]), -x, `-2^${exponent}`);
  }
});
