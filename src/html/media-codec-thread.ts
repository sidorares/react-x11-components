// The thread a page's peer connections encode and decode their media on
// (`./media-codecs.ts`, "the codecs' thread"). It loads libav.js, says it is
// up and whether libav.js was to be had, and then holds the codecs the
// page's thread opens, by number, calling each one's `encode` or `decode` as
// it is asked and moving back what that came to. Its codecs are
// `media-codecs.ts`'s own, as the page's thread would make them where no
// thread can be made, so the two cannot come to different bytes.
//
// It is started from this file beside its module (`threadEntry`), the
// JavaScript in `dist/` and the TypeScript run from source, and ended by the
// page's thread once the last codec is closed.
import { buffersOf, codecHere, loadLibAV } from './media-codecs.js';
import type {
  AnyCodec,
  FromCodecThread,
  ToCodecThread,
} from './media-codecs.js';
import { nodeModule } from './scripts/platform.js';
import type { WorkerThreadsModule } from './scripts/platform.js';

const { parentPort } = await nodeModule<WorkerThreadsModule>('worker_threads');
const port = parentPort!;
const libav = await loadLibAV();

const codecs = new Map<number, AnyCodec>();

const tell = (m: FromCodecThread, transfer: ArrayBuffer[] = []): void => {
  try {
    port.postMessage(m, transfer);
  } catch {
    port.postMessage(m);
  }
};

async function heard(m: ToCodecThread): Promise<void> {
  if (m.op === 'open') {
    const codec = libav && codecHere(libav, m.kind, m.codec);
    if (codec) codecs.set(m.id, codec);
    return;
  }
  if (m.op === 'close') {
    codecs.get(m.id)?.close();
    codecs.delete(m.id);
    return;
  }
  const codec = codecs.get(m.id) as
    | Record<'encode' | 'decode', ((...args: unknown[]) => unknown) | undefined>
    | undefined;
  let result: unknown;
  try {
    result = await codec?.[m.method]?.(...m.args);
  } catch {
    result = undefined;
  }
  tell({ op: 'done', call: m.call, result }, buffersOf(result));
}

port.on('message', (m: never) => void heard(m as ToCodecThread));
tell({ op: 'up', libav: !!libav });
