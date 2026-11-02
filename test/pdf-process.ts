// What `test/pdf.test.ts` runs in a process of its own, since what a thread
// holds open cannot show from inside a runner, which ends the process. A file
// and not an `--eval`: a worker inherits that flag and fails to start, and the
// engine then runs on this thread and there is nothing to find out.
// Not a `.test.ts` file, so `tsx --test test/*.test.ts` does not run it.
import { defaultPdfEngine } from '../src/pdf/thread.js';
import { makePdf } from './pdf-fixture.js';

const engine = await defaultPdfEngine();
console.log(engine?.constructor.name ?? 'no engine');

if (engine && process.argv[2] === 'slow') {
  // Slow enough that a thread holding nothing open is found out: an answer
  // that comes back at once finds the process still there to hear it.
  const rects: Array<[number, number, number, number, number, number, number]> =
    [];
  for (let i = 0; i < 120000; i++) {
    rects.push([i % 600, (i * 7) % 780, 3, 3, (i % 10) / 10, 0.5, 0.2]);
  }
  const info = await engine.open(
    makePdf({ pages: [{ width: 612, height: 792, rects }] }),
  );
  const tile = await engine.render(info.handle, {
    page: 0,
    level: 2,
    x: 0,
    y: 0,
    width: 512,
    height: 512,
  });
  engine.close(info.handle);
  console.log(tile ? 'drew' : 'no tile');
}
console.log('ended');
