// The script engine, as `<Html scripts>` loads it: one chunk, reached only
// through the dynamic `import()` in `./hook.ts`, so that an application
// whose documents run no scripts bundles none of it — the `node:vm`
// context, the DOM facade, the canvas rasterizer, WebGL's stand-in, the
// workers and the frames (`test/treeshake.test.ts`).
export { SCRIPTS_CONTAINED } from './engine.js';
export { ScriptRunner, SCRIPT_TIMEOUT_MS } from './runner.js';
export { FrameHolder, embeddedMounts } from './frames.js';
