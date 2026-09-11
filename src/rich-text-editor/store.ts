// A value per block, with a subscription per block.
//
// What lets a decoration, or a node selection, repaint the one block it is
// on: the block's component subscribes to its own key (React's
// `useSyncExternalStore`), so a plugin lighting up a search match re-renders
// that paragraph — not the document, and not the chain of memoized blocks
// between the document and the paragraph, which would each have to be told.
export class KeyedStore<T> {
  private values = new Map<string, T>();
  private listeners = new Map<string, Set<() => void>>();

  get(key: string): T | undefined {
    return this.values.get(key);
  }

  /** Set, or with `undefined` clear, one key's value. Identical values are
   *  not news: nothing is told. */
  set(key: string, value: T | undefined): void {
    if (Object.is(this.values.get(key), value)) return;
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    const set = this.listeners.get(key);
    if (set) for (const fn of [...set]) fn();
  }

  keys(): IterableIterator<string> {
    return this.values.keys();
  }

  subscribe(key: string, fn: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(key);
    };
  }
}
