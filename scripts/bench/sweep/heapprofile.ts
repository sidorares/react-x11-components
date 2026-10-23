// An allocation sampling profile (`.heapprofile`, htmlpage.mjs's `ALLOC`),
// read two ways:
//
//   npx tsx scripts/bench/sweep/heapprofile.ts self <file|dir> [count]
//   npx tsx scripts/bench/sweep/heapprofile.ts callers <file|dir> <function> [depth]
//
// `self` is where the bytes are allocated, by function; `callers` who
// allocates through a function, as caller chains. A directory is read as
// one profile of every `.heapprofile` in it whose name matches `MATCH`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}
interface Node {
  callFrame: CallFrame;
  selfSize: number;
  children: Node[];
}

const [mode, target, arg, extra] = process.argv.slice(2);
if (!mode || !target) {
  console.error('usage: heapprofile.ts self|callers <file|dir> [...]');
  process.exit(1);
}
const match = new RegExp(process.env.MATCH ?? '');
const files = statSync(target).isDirectory()
  ? readdirSync(target)
      .filter((f) => f.endsWith('.heapprofile') && match.test(f))
      .map((f) => path.join(target, f))
  : [target];

const nameOf = (cf: CallFrame): string => {
  const where = cf.url.replace(/.*\/(src|lib|dist|node_modules)\//, '$1/');
  return `${cf.functionName || '(anon)'} ${where}:${cf.lineNumber + 1}`;
};

const self = new Map<string, number>();
const chains = new Map<string, number>();
let total = 0;
for (const file of files) {
  const { head } = JSON.parse(readFileSync(file, 'utf8')) as { head: Node };
  const stack: string[] = [];
  const walk = (node: Node) => {
    const name = nameOf(node.callFrame);
    stack.push(name);
    if (node.selfSize) {
      total += node.selfSize;
      self.set(name, (self.get(name) ?? 0) + node.selfSize);
      if (mode === 'callers' && arg) {
        const at = stack.findIndex((n) => n.includes(arg));
        if (at >= 0) {
          const depth = Number(extra ?? 6);
          const chain = stack
            .slice(Math.max(0, at - depth), at + 1)
            .reverse()
            .join('\n    <- ');
          chains.set(chain, (chains.get(chain) ?? 0) + node.selfSize);
        }
      }
    }
    for (const child of node.children) walk(child);
    stack.pop();
  };
  walk(head);
}
const mb = (bytes: number) => (bytes / 2 ** 20).toFixed(2).padStart(8);
console.log(`${mb(total)} MB sampled in ${files.length} profile(s)`);
if (mode === 'self') {
  const rows = [...self].sort((a, b) => b[1] - a[1]);
  for (const [name, bytes] of rows.slice(0, Number(arg ?? 40)))
    console.log(`${mb(bytes)}  ${name}`);
} else {
  const rows = [...chains].sort((a, b) => b[1] - a[1]);
  for (const [chain, bytes] of rows.slice(0, 15))
    console.log(`${mb(bytes)}  ${chain}\n`);
}
