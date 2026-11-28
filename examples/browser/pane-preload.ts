// What a spare pane (`spare-pane.ts`) loads before it is any tab's: run with
// `--import` ahead of core's pane entry, so by the time a `<Frame>` takes the
// process and its hello asks for `page.tsx`, the module is loaded, or on its
// way. The scripts runtime is loaded too where the browser said its pages run
// them.
//
// Two things here are load-bearing. **The import is not awaited**: an
// `--import` that is still running holds back the entry, and a spare taken
// while it loads should go on from where it is — the pane's own `import()`
// of `page.tsx` joins the load in flight. And **nothing here listens for a
// message**: a listener starts reading the IPC channel, and the hello it read
// would never reach core's pane entry, which listens once its own imports are
// in.
//
// A failure is left for the hello to find: the pane's own import of
// `page.tsx` fails the same way, and reports it as a pane that could not
// load.
// the same URL `browser.tsx` hands the pane (`PAGE`), so it is the same module
void import(new URL('./page.tsx', import.meta.url).href)
  .then(async () => {
    if (process.env.BROWSER_PRELOAD_SCRIPTS !== '1') return;
    const { preloadHtmlScripts } = await import('../../src/html/index.js');
    await preloadHtmlScripts();
  })
  .catch(() => {});

// `page.tsx` starts a network thread and timers, which would keep a spare
// alive after the browser that started it has gone. A pane that was taken
// closes itself when its host goes (core's `runFrameChild`), and this is the
// backstop, a while after, for one that never was.
process.once('disconnect', () => {
  setTimeout(() => process.exit(0), 10_000);
});
