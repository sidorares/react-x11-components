// The host's half of a page's WebGL contexts (`webgl.ts`): each context's GL
// behind a number, and what it drew handed over as its canvas's pixels.
//
// **One context is current at a time, and each call says which.** That is
// `HtmlGLContext`'s to see to (`src/html/webgl.ts`), and why calls cross in
// batches: a frame of a fluid simulation is a few hundred of them, and no call
// of a page's is worth a crossing and a `makeCurrent` of its own.
//
// **A frame is read out as it is painted, and not as it is drawn.** Reading a
// GPU's pixels back waits for all it has been asked and copies millions of
// them, which a canvas out of view, or a frame a slower paint never shows, is
// not worth: `present` says a frame is owed and that the box wants painting,
// and only a paint that reaches the box reads it (`settle`, from
// `DomHost.canvas`). Apple's headline glows in a canvas scrolled away for most
// of a load, and read at each frame it starved the page's downloads.
//
// **A page has as many as Chrome lets it** (`MOST_CONTEXTS`). The oldest goes
// where a page makes more, as a browser's does, and what it asks after that is
// nothing: a context a page thinks it has answers as one that draws nothing,
// which is what a lost one is short of the event a page may not listen for.

import type { Element } from 'domhandler';

import type {
  HtmlGLCommand,
  HtmlGLContext,
  HtmlGLOptions,
  HtmlWebGL,
} from '../webgl.js';

/** Chrome's limit on the live WebGL contexts of a page. */
const MOST_CONTEXTS = 16;

/** Where a context's frame goes. */
export interface GLSeams {
  webgl(): HtmlWebGL | undefined;
  /** The element's pixels, of this size, for a frame to be read into. */
  pixels(element: Element, width: number, height: number): Uint8ClampedArray;
  /** A new frame is owed them, which `settle` reads. */
  drawn(element: Element): void;
}

interface Held {
  context: HtmlGLContext;
  width: number;
  height: number;
  /** Whether nothing shows through it. */
  opaque: boolean;
  /** Where it was last presented, where that has not been read. */
  owed: Element | null;
}

export class PageContexts {
  private readonly _held = new Map<number, Held>();
  private readonly _byElement = new WeakMap<Element, Held>();
  private _next = 1;

  constructor(private readonly _seams: GLSeams) {}

  /** A context of `options`' kind: its number and what it offers, as JSON,
   *  or null where there is no GL to be had. */
  open(options: HtmlGLOptions): string {
    const context = this._seams.webgl()?.open(options);
    if (!context) return 'null';
    if (this._held.size >= MOST_CONTEXTS) {
      const [oldest] = this._held.keys();
      this.close(oldest);
    }
    const id = this._next;
    this._next += 1;
    const { width, height } = options;
    this._held.set(id, {
      context,
      width,
      height,
      opaque: !options.alpha,
      owed: null,
    });
    return JSON.stringify({ id, extensions: context.extensions });
  }

  run(id: number, calls: string): void {
    this._held.get(id)?.context.run(JSON.parse(calls) as HtmlGLCommand[]);
  }

  /** As `run`, and what the last call came to, as JSON. */
  ask(id: number, calls: string): string {
    const held = this._held.get(id);
    if (!held) return 'null';
    const answer = held.context.run(JSON.parse(calls) as HtmlGLCommand[]);
    return JSON.stringify(answer ?? null);
  }

  resize(id: number, width: number, height: number): void {
    const held = this._held.get(id);
    if (!held) return;
    held.width = width;
    held.height = height;
    held.context.resize(width, height);
  }

  present(id: number, element: Element): void {
    const held = this._held.get(id);
    if (!held || !held.width || !held.height) return;
    held.owed = element;
    this._byElement.set(element, held);
    this._seams.drawn(element);
  }

  /** What `present` owes the element's pixels, read in. */
  settle(element: Element): void {
    const held = this._byElement.get(element);
    if (!held?.owed) return;
    held.owed = null;
    held.context.present(this._seams.pixels(element, held.width, held.height));
  }

  /** Whether the element's picture has nothing behind it show through. */
  opaque(element: Element): boolean {
    return this._byElement.get(element)?.opaque ?? false;
  }

  close(id: number): void {
    this._held.get(id)?.context.dispose();
    this._held.delete(id);
  }

  dispose(): void {
    for (const id of [...this._held.keys()]) this.close(id);
  }
}
