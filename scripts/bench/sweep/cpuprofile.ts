// A V8 CPU profile, read four ways. Run a probe with
// `NODE_OPTIONS=--cpu-prof --cpu-prof-dir=<dir>` and point this at the
// directory; it reads the largest `.cpuprofile` there, which is the probe's
// own process rather than a helper's.
//
//   npx tsx scripts/bench/sweep/cpuprofile.ts self <dir> [count]
//   npx tsx scripts/bench/sweep/cpuprofile.ts incl <dir> <regex>
//   npx tsx scripts/bench/sweep/cpuprofile.ts callers <dir> <function> [depth]
//   npx tsx scripts/bench/sweep/cpuprofile.ts tree <dir> <function> [depth]
//
// `self` is where the time is spent; `incl` is how much time passes through
// every function whose name matches; `callers` is who spends a function's
// time, as caller chains — the view that explained both `createElement` and
// fontkit's cmap `lookup` this round; `tree` is everything under a function,
// merged across the places it runs, down to 20 ms.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}
interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
}
interface Profile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
}

const [mode, dir, arg, extra] = process.argv.slice(2);
if (!mode || !dir) {
  console.error('usage: cpuprofile.ts self|incl|callers|tree <dir> [...]');
  process.exit(1);
}
const file = readdirSync(dir)
  .filter((f) => f.endsWith('.cpuprofile'))
  .map((f) => path.join(dir, f))
  .sort((a, b) => statSync(b).size - statSync(a).size)[0];
if (!file) {
  console.error(`no .cpuprofile in ${dir}`);
  process.exit(1);
}
const profile = JSON.parse(readFileSync(file, 'utf8')) as Profile;
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of profile.nodes)
  for (const c of n.children ?? []) parent.set(c, n.id);
/** Microseconds of samples that landed in each node, i.e. its self time. */
const selfOf = new Map<number, number>();
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i];
  selfOf.set(id, (selfOf.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
}
const nameOf = (id: number): string => {
  const cf = byId.get(id)!.callFrame;
  const where = cf.url.replace(/.*\/(src|lib|node_modules)\//, '$1/');
  return `${cf.functionName || '(anon)'} ${where}:${cf.lineNumber + 1}`;
};
const ms = (us: number) => (us / 1000).toFixed(1).padStart(8);
const top = (m: Map<string, number>, n: number) =>
  [...m].sort((a, b) => b[1] - a[1]).slice(0, n);

const total = [...selfOf.values()].reduce((a, b) => a + b, 0);
console.log(`${path.basename(file)}: ${(total / 1000).toFixed(0)} ms sampled`);

if (mode === 'self') {
  const self = new Map<string, number>();
  for (const [id, us] of selfOf)
    self.set(nameOf(id), (self.get(nameOf(id)) ?? 0) + us);
  for (const [k, us] of top(self, Number(arg ?? 25))) console.log(ms(us), k);
} else if (mode === 'incl') {
  // a recursive function counts once per sample, not once per frame
  const match = new RegExp(arg ?? '.');
  const incl = new Map<string, number>();
  for (const [id, us] of selfOf) {
    const seen = new Set<string>();
    for (let cur: number | undefined = id; cur != null; cur = parent.get(cur)) {
      const k = nameOf(cur);
      if (seen.has(k) || !match.test(k)) continue;
      seen.add(k);
      incl.set(k, (incl.get(k) ?? 0) + us);
    }
  }
  for (const [k, us] of top(incl, 25)) console.log(ms(us), k);
} else if (mode === 'callers') {
  const depth = Number(extra ?? 3);
  const chains = new Map<string, number>();
  for (const [id, us] of selfOf) {
    if (byId.get(id)!.callFrame.functionName !== arg) continue;
    const chain: string[] = [];
    for (
      let cur = parent.get(id);
      cur != null && chain.length < depth;
      cur = parent.get(cur)
    ) {
      chain.push(nameOf(cur));
    }
    const k = chain.join('  <-  ');
    chains.set(k, (chains.get(k) ?? 0) + us);
  }
  for (const [k, us] of top(chains, 12)) console.log(ms(us), k);
} else if (mode === 'tree') {
  const maxDepth = Number(extra ?? 4);
  const inclusive = new Map<number, number>();
  const inclusiveOf = (id: number): number => {
    const known = inclusive.get(id);
    if (known != null) return known;
    let us = selfOf.get(id) ?? 0;
    for (const c of byId.get(id)!.children ?? []) us += inclusiveOf(c);
    inclusive.set(id, us);
    return us;
  };
  interface Branch {
    us: number;
    kids: Map<string, Branch>;
  }
  const root: Branch = { us: 0, kids: new Map() };
  const add = (id: number, depth: number, into: Branch) => {
    into.us += inclusiveOf(id);
    if (depth >= maxDepth) return;
    for (const c of byId.get(id)!.children ?? []) {
      const k = nameOf(c);
      let branch = into.kids.get(k);
      if (!branch) into.kids.set(k, (branch = { us: 0, kids: new Map() }));
      add(c, depth + 1, branch);
    }
  };
  // every outermost frame of the function, merged into one tree
  const visit = (id: number, inside: boolean) => {
    const hit =
      !inside &&
      (byId.get(id)!.callFrame.functionName || '').includes(arg ?? '');
    if (hit) add(id, 0, root);
    for (const c of byId.get(id)!.children ?? []) visit(c, inside || hit);
  };
  visit(profile.nodes[0].id, false);
  console.log(`${arg}: ${(root.us / 1000).toFixed(0)} ms`);
  const print = (branch: Branch, indent: number) => {
    for (const [k, b] of [...branch.kids].sort((x, y) => y[1].us - x[1].us)) {
      if (b.us < 20_000) continue;
      console.log(`${' '.repeat(indent)}${ms(b.us)} ${k}`);
      print(b, indent + 2);
    }
  };
  print(root, 2);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(1);
}
