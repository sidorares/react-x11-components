// ListModel / ListElement, and the one helper every model consumer shares.
//
// A ListModel is rows of plain objects. Inline `ListElement` children seed
// it; the mutation methods (`append`, `remove`, `set`, …) are facade
// methods, and every mutation bumps a hidden revision slot the consumers
// (Repeater, ListView) watch — a coarse rebuild, which is the honest P1
// answer; incremental delegate reuse is DelegateModel's job, later.

import { QmlInstance, instanceOf, type QmlTypeDef } from './objects.js';
import { Slot } from './slots.js';

type Row = Record<string, unknown>;

const rowsOf = (m: QmlInstance): Row[] => m.state.rows as Row[];

function mutate(m: QmlInstance, fn: (rows: Row[]) => void): void {
  fn(rowsOf(m));
  m.slot('count').assign(rowsOf(m).length);
  m.slot('__rev').assign((m.slot('__rev').peek() as number) + 1);
}

export const modelTypes: Record<string, QmlTypeDef> = {
  ListElement: {
    nonVisual: true,
    dynamicProperties: true,
    properties: {},
  },

  ListModel: {
    nonVisual: true,
    properties: { count: { default: 0 }, __rev: { default: 0 } },
    init(m) {
      const rows: Row[] = [];
      for (const el of m.children) {
        if (el.typeInfo.name !== 'ListElement') continue;
        const row: Row = {};
        for (const [name, slot] of el.slots) row[name] = slot.peek();
        rows.push(row);
      }
      m.state.rows = rows;
      m.slot('count').assign(rows.length);
      m.methods.set('get', (i) => rowsOf(m)[Number(i)]);
      m.methods.set('append', (row) => mutate(m, (r) => r.push(row as Row)));
      m.methods.set('insert', (i, row) =>
        mutate(m, (r) => r.splice(Number(i), 0, row as Row)),
      );
      m.methods.set('remove', (i, n) =>
        mutate(m, (r) => r.splice(Number(i), n === undefined ? 1 : Number(n))),
      );
      m.methods.set('set', (i, row) =>
        mutate(m, (r) => {
          r[Number(i)] = { ...r[Number(i)], ...(row as Row) };
        }),
      );
      m.methods.set('setProperty', (i, name, value) =>
        mutate(m, (r) => {
          r[Number(i)] = { ...r[Number(i)], [String(name)]: value };
        }),
      );
      m.methods.set('clear', () => mutate(m, (r) => (r.length = 0)));
    },
  },
};

export interface ResolvedModel {
  rows: unknown[];
  /** Present for a ListModel: the revision slot a consumer watches. */
  revSlot: Slot | null;
}

/** number | array | ListModel → rows a Repeater/ListView can walk. */
export function resolveModel(value: unknown): ResolvedModel {
  const inst = instanceOf(value);
  if (inst && inst.typeInfo.name === 'ListModel') {
    return { rows: rowsOf(inst), revSlot: inst.slot('__rev') };
  }
  if (typeof value === 'number') {
    return {
      rows: Array.from({ length: Math.max(0, Math.floor(value)) }, (_, i) => i),
      revSlot: null,
    };
  }
  if (Array.isArray(value)) return { rows: value, revSlot: null };
  return { rows: [], revSlot: null };
}

/** The context properties a delegate row sees: index, modelData, and — for
 * object rows — each role by name, the way QML exposes ListModel roles. */
export function delegateExtras(
  rows: unknown[],
  index: number,
): Record<string, unknown> {
  const data = rows[index];
  const extras: Record<string, unknown> = { index, modelData: data };
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [k, v] of Object.entries(data as Row)) {
      if (!(k in extras)) extras[k] = v;
    }
  }
  return extras;
}
