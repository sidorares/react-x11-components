// The intermediate representation both halves share: the parser produces it,
// the runtime instantiates it, and the future compiler will serialize it.
// Everything is plain data — no methods, no cycles — so a document parses
// once and instantiates many times (a Repeater's delegate is one ObjectIR,
// however many rows exist).

export interface QmlImport {
  /** `import QtQuick 2.15` — a registry module name. */
  module?: string;
  /** `import "./widgets"` — a path import (resolved by the host app). */
  path?: string;
  version?: string;
  alias?: string;
}

export interface ObjectIR {
  type: string;
  id: string | null;
  members: MemberIR[];
  loc: number;
}

export type ValueIR =
  /** A JavaScript expression, compiled lazily by the runtime. */
  | { kind: 'expr'; src: string; loc: number }
  /** `prop: { …statements }` — a script binding (still reactive). */
  | { kind: 'block'; src: string; loc: number }
  /** `delegate: Component { … }`, `background: Rectangle { … }`. */
  | { kind: 'object'; object: ObjectIR }
  /** `states: [State { … }, …]` — an array of object templates. */
  | { kind: 'array'; items: ValueIR[] };

export interface AliasTargetIR {
  kind: 'alias-target';
  path: string[];
}

export type MemberIR =
  | {
      kind: 'property';
      name: string;
      propType: string;
      readonly: boolean;
      default: boolean;
      required: boolean;
      value: ValueIR | AliasTargetIR | null;
      loc: number;
    }
  | {
      kind: 'signal';
      name: string;
      params: Array<{ type: string; name: string }>;
      loc: number;
    }
  | {
      kind: 'function';
      name: string;
      params: string[];
      body: string;
      loc: number;
    }
  | { kind: 'binding'; path: string[]; value: ValueIR; loc: number }
  | { kind: 'group'; bindings: BindingMemberIR[]; loc: number }
  | { kind: 'object'; object: ObjectIR; loc: number }
  | { kind: 'value-source'; object: ObjectIR; on: string[]; loc: number }
  | { kind: 'id'; id: string; loc: number }
  | { kind: 'inline-component'; name: string; object: ObjectIR; loc: number };

export type BindingMemberIR = Extract<MemberIR, { kind: 'binding' }>;

export interface QmlDocument {
  fileName: string;
  imports: QmlImport[];
  pragmas: string[];
  root: ObjectIR;
}
