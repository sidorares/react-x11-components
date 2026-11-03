// Writes the table of `test/html/control-states.ts`: what each element of its
// document answers to the pseudo-classes that read a control's state, as its
// `matches()` answers in Chromium:
//
//   CHROME=<chromium> node --import tsx scripts/conformance/control-states.ts
//
// The document and the pseudo-classes are the file's, and only the table is
// written, none of it by hand. Run prettier over the file after it.
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Chrome } from '../zengarden/chrome.js';
import {
  CONTROL_STATE_PSEUDOS,
  CONTROL_STATE_SOURCE,
} from '../../test/html/control-states.js';

const FIXTURE = new URL('../../test/html/control-states.ts', import.meta.url);
const TABLE = '/** Each element, by its id, and what it matched';

const page = join(tmpdir(), `control-states-${process.pid}.html`);
writeFileSync(page, CONTROL_STATE_SOURCE);
const chrome = await Chrome.launch();
try {
  const { targetId } = (await chrome.send('Target.createTarget', {
    url: pathToFileURL(page).href,
  })) as { targetId: string };
  const { sessionId } = (await chrome.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  })) as { sessionId: string };
  const expression = `new Promise((done) => {
    const pseudos = ${JSON.stringify(CONTROL_STATE_PSEUDOS)};
    const read = () => {
      const table = [];
      for (const el of document.querySelectorAll('[id]')) {
        table.push([el.id, pseudos.filter((p) => el.matches(p)).join(' ')]);
      }
      done(JSON.stringify(table));
    };
    // the target starts on a blank page, which is complete already
    const ready = () =>
      document.readyState === 'complete' && document.getElementById('plain')
        ? read()
        : setTimeout(ready, 10);
    ready();
  })`;
  // and going from it to the document ends what was asked of it
  const evaluate = async (): Promise<{ result: { value: string } }> => {
    for (;;) {
      try {
        return (await chrome.send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
        )) as { result: { value: string } };
      } catch (error) {
        if (!/context|navigated/i.test(String(error))) throw error;
      }
    }
  };
  const { result } = await evaluate();
  const table = JSON.parse(result.value) as [string, string][];
  const file = readFileSync(FIXTURE, 'utf8');
  writeFileSync(
    FIXTURE,
    `${file.slice(0, file.indexOf(TABLE))}${TABLE}, in the order above. */
export const CHROME_CONTROL_STATES: Record<string, string> = {
${table.map(([id, got]) => `  ${JSON.stringify(id)}: ${JSON.stringify(got)},`).join('\n')}
};
`,
  );
} finally {
  await chrome.close();
}
