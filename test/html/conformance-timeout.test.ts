// What the WPT runner (`scripts/conformance/testharness.tsx`) does of the
// harness's own timeouts: `WPT_TIMEOUT_MULTIPLIER`.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';

import { RUNNER_RUNS, runTests } from './conformance-runner.js';

const test = RUNNER_RUNS ? nodeTest : nodeTest.skip;

// The part of testharness.js the runner's reporter asks for, and its
// timeout: a frame's ends 300 ms after it starts, and is told to the window
// around it.
const HARNESS = `
  var length = 300, timer = 0, told = [];
  function arm() {
    clearTimeout(timer);
    if (window !== top) {
      timer = setTimeout(function () { parent.postMessage({ type: 'complete' }, '*'); }, length);
    }
  }
  function setup(given) {
    window.given = given;
    if ('timeout_multiplier' in given) length *= given.timeout_multiplier;
    arm();
  }
  function add_result_callback() {}
  function add_completion_callback(tell) { told.push(tell); }
  function end(name, passed) {
    told.forEach(function (tell) {
      tell([{ name: name, status: passed ? 0 : 1, message: null }], { status: 0, message: null });
    });
  }
  arm();`;
const LOAD = `<!doctype html>
<script src="/resources/testharness.js"></script>
<script src="/resources/testharnessreport.js"></script>`;

// as WPT's `common/security-features` has it: the first message there is, is
// taken for the frame's answer
const PAGES = {
  'resources/testharness.js': HARNESS,
  'frame.html': `${LOAD}<script>
    setTimeout(function () { parent.postMessage({ headers: {} }, '*'); }, 900);
  </script>`,
  'slow.html': `${LOAD}<script>
    addEventListener('message', function (e) {
      end(Object.keys(given).join() + ' ' + Object.keys(e.data).join(), true);
    }, { once: true });
  </script><iframe src="frame.html"></iframe>`,
};

const named = async (env: Record<string, string>) =>
  (await runTests(['slow.html'], PAGES, 60000, env)).map((o) =>
    o.subtests?.map((s) => s.name).join(),
  );

test("a frame's harness ends at its own timeout, which a multiplier puts off, and none is handed over unless it is set", async () => {
  assert.deepEqual(await named({}), ['output type']);
  assert.deepEqual(await named({ WPT_TIMEOUT_MULTIPLIER: '10' }), [
    'output,timeout_multiplier headers',
  ]);
});
