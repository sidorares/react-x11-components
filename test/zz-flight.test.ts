import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React, { useState } from 'react';
import { renderX11, cleanup, screen, fireEvent, act, waitFor } from 'react-x11/test';
import { ReorderItem, ReorderList, type ReorderChange } from '../src/index.js';
const h = React.createElement;
afterEach(cleanup);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function View({ live }: { live: boolean }): React.ReactElement {
  const [order, setOrder] = useState(['a', 'b', 'c']);
  return h('window', { width: 300, height: 220 } as never,
    h(ReorderList, {
      'data-testname': 'l',
      dropAnimation: 80,
      onReorder: (c: ReorderChange) => { if (live) setOrder(c.items as string[]); },
      style: { gap: 4, padding: 8 },
    },
    order.map((id) => h(ReorderItem, { key: id, id, 'data-testname': `l-${id}`, style: { width: 200, height: 30 } }, h('text', null, id)))));
}

async function run(live: boolean): Promise<string> {
  await renderX11(h(View, { live }), { wrap: false } as never);
  await sleep(300); await act();
  const from = screen.getByTestName('l-a'); const to = screen.getByTestName('l-c');
  await act(async () => { fireEvent.mouseDown(from); });
  await act(async () => { fireEvent.mouseMove(from, { dx: 8 }); });
  await sleep(30); await act();
  await act(async () => { fireEvent.mouseMove(to, { dy: 10 }); });
  await sleep(30); await act();
  await act(async () => { fireEvent.mouseUp(to, { dy: 10 }); });
  const r = await Promise.race([
    waitFor(() => { assert.ok(screen.queryByTestName('l-a-flight') === null); }).then(() => 'cleared').catch(() => 'waitFor threw'),
    sleep(6000).then(() => 'HUNG'),
  ]);
  return r;
}

test('flight with no reorder', async () => {
  assert.strictEqual(await run(false), 'cleared');
});
test('flight WITH the reorder applied', async () => {
  assert.strictEqual(await run(true), 'cleared');
});
