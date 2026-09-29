// `CodeRunCache`: `codeRuns` kept between calls, so a text that changes a
// little at a time — a fence being streamed — is tokenized again from the
// line that changed rather than from the top. What is held to here is that
// it highlights exactly what `codeRuns` does, whatever the change, and that
// the lines above a change keep the runs they had.
import { test } from 'node:test';
import assert from 'node:assert';

import {
  autoTokenStyles,
  codeRuns,
  CodeRunCache,
} from '../src/code-language/index.js';
import type { CodeRun } from '../src/code-language/index.js';

const OPTS = { styles: autoTokenStyles('#ffffff'), color: '#333333' };

/** Runs merged where they touch in the same style: two cuts of the same
 *  highlighting compare equal. */
function merged(runs: readonly CodeRun[]): CodeRun[] {
  const out: CodeRun[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (
      last &&
      last.color === run.color &&
      last.weight === run.weight &&
      last.style === run.style
    ) {
      last.text += run.text;
    } else {
      out.push({ ...run });
    }
  }
  return out;
}

test('a kept tokenizer highlights what codeRuns does, however the text changes', () => {
  const cache = new CodeRunCache();
  const texts = [
    'const a = 1;\nlet b = "x";',
    // a line appended that opens a comment…
    'const a = 1;\nlet b = "x";\n/* open',
    // …and one that closes it
    'const a = 1;\nlet b = "x";\n/* open\nstill comment */ let c = 2;',
    // an edit near the top that changes the colour of everything below it
    'const a = 1;\n/* early\nlet b = "x";\n/* open\nstill comment */ let c = 2;',
    // and one that takes it away again
    'const a = 1;\nlet b = "x";\n/* open\nstill comment */ let c = 2;',
    'x',
    '',
  ];
  for (const text of texts) {
    assert.deepStrictEqual(
      merged(cache.runs(text, 'ts', OPTS)),
      merged(codeRuns(text, 'ts', OPTS)),
      JSON.stringify(text),
    );
  }
  // and a language it switches to
  assert.deepStrictEqual(
    merged(cache.runs('x = 1 # note', 'python', OPTS)),
    merged(codeRuns('x = 1 # note', 'python', OPTS)),
  );
  cache.dispose();
});

test('an append keeps the runs of every line above it', () => {
  const cache = new CodeRunCache();
  const before = cache.runs('let a = 1;\nlet b = 2;', 'js', OPTS);
  const after = cache.runs('let a = 1;\nlet b = 2;\nlet c = 3;', 'js', OPTS);
  assert.ok(before.length < after.length);
  for (let i = 0; i < before.length; i++) {
    assert.strictEqual(after[i], before[i], `run ${i} is the one it was`);
  }
  assert.equal(
    after.map((r) => r.text).join(''),
    'let a = 1;\nlet b = 2;\nlet c = 3;',
  );
  cache.dispose();
});

test('each run is decorated once, when it is made', () => {
  let made = 0;
  const cache = new CodeRunCache((run) => {
    made++;
    return { ...run, size: 12 };
  });
  cache.runs('let a = 1;\nlet b = 2;', 'js', OPTS);
  const first = made;
  cache.runs('let a = 1;\nlet b = 2;\nlet c = 3;', 'js', OPTS);
  assert.ok(made - first < first, 'only the new line was decorated again');
  cache.dispose();
});
