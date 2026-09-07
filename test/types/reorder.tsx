// Type-level test: the parts compile as JSX against react-x11's namespace,
// the unions are closed (a typo in `orientation` is an error, not a silent
// fallback), an item names itself, the events carry the list-and-index
// shape, and every rung of the ladder in `docs/components/reorder.md` is a
// small diff on the one before.
import React from 'react';
import { Button } from 'react-x11';
import type { Style } from 'react-x11/style';

import {
  ReorderHandle,
  ReorderItem,
  ReorderList,
  arrayMove,
  closestSlot,
  insertManyAtSlot,
  moveManyToSlot,
  moveToSlot,
  useReorderItem,
} from '../../src/index.js';
import type {
  ReorderChange,
  ReorderCombine,
  ReorderDragEnd,
  ReorderDragStart,
  ReorderDragUpdate,
  ReorderDrop,
  ReorderDropQuery,
  ReorderId,
  ReorderInput,
  ReorderInsert,
  ReorderItemProps,
  ReorderItemState,
  ReorderListProps,
  ReorderOrientation,
  ReorderPreviewSize,
  ReorderRemove,
  ReorderStyles,
} from '../../src/index.js';

interface Todo {
  id: number;
  title: string;
}

declare const todos: Todo[];
declare const setTodos: (next: Todo[] | ((prev: Todo[]) => Todo[])) => void;

/** The shortest thing that works. */
export const plain = (
  <ReorderList
    onReorder={(e: ReorderChange) =>
      setTodos((list) => arrayMove(list, e.from, e.to))
    }
  >
    {todos.map((todo) => (
      <ReorderItem key={todo.id} id={todo.id}>
        <text>{todo.title}</text>
      </ReorderItem>
    ))}
  </ReorderList>
);

/** Every root prop, a handle in the item, a control beside it. */
export const configured = (
  <ReorderList
    id="todo"
    group="board"
    orientation="horizontal"
    disabled={false}
    onReorder={(e) => void e.items}
    onInsert={(e: ReorderInsert) =>
      void [e.source.list, e.source.index, e.event.items]
    }
    onRemove={(e: ReorderRemove) => void [e.to?.list, e.event.action]}
    accept={['files', 'text/plain']}
    onDrop={(d: ReorderDrop) => void [d.index, d.event.files, d.event.text]}
    preview
    renderPreview={(state: ReorderItemState) => <text>{String(state.id)}</text>}
    styles={{
      item: (state) => state.lifted && { backgroundColor: '$surfaceHover' },
      handle: { padding: 4 },
      indicator: [{ height: 3 }],
      preview: { borderRadius: 8 },
    }}
    style={{ gap: 4 }}
    data-testname="list"
  >
    <ReorderItem
      id="a"
      disabled
      dragData={{ 'text/plain': 'a', 'text/uri-list': () => 'file:///a\r\n' }}
      dragActions={['copy', 'move']}
      aria-label="Alpha"
      style={[{ padding: 8 }]}
      data-testname="item-a"
    >
      <ReorderHandle
        aria-label="Move Alpha"
        style={{ padding: 2 }}
        data-testname="grip"
      />
      <text>Alpha</text>
      <Button label="Open" onPress={() => {}} />
    </ReorderItem>
    <ReorderItem id={2}>
      <ReorderHandle>
        <text>⋮⋮</text>
      </ReorderHandle>
    </ReorderItem>
  </ReorderList>
);

/** `accept` takes core's whole vocabulary. */
export const predicate = (
  <ReorderList
    accept={(types) => types.includes('image/png')}
    onDrop={() => {}}
  />
);

/** The unions are closed. */
// @ts-expect-error -- 'diagonal' is not an orientation
export const badOrientation = <ReorderList orientation="diagonal" />;
// @ts-expect-error -- an item names itself
export const missingId = <ReorderItem>…</ReorderItem>;
// @ts-expect-error -- 'link' is a drag action; 'paste' is not
export const badAction = <ReorderItem id="a" dragActions={['paste']} />;

/** The prop bags are exact enough to reuse. */
export const reused: ReorderListProps = {
  orientation: 'vertical' satisfies ReorderOrientation,
  group: 'board',
};
export const itemBag: ReorderItemProps = { id: 'a', disabled: true };
export const stylesBag: ReorderStyles = { indicator: { height: 4 } };

/** `style` takes one style or a list, like everywhere in the package. */
const one: Style = { flexGrow: 1 };
export const styles = (
  <ReorderList style={one}>
    <ReorderItem id="a" style={[one, { padding: 2 }]} />
  </ReorderList>
);

/** The model is generic over what the app holds, and ids are strings or numbers. */
export const moved: Todo[] = arrayMove(todos, 0, 2);
export const ids: ReorderId[] = ['a', 1];
export const slot = closestSlot(
  [{ x: 0, y: 0, width: 10, height: 10 }],
  { x: 1, y: 1 },
  'vertical',
  'rtl',
);
export const move = moveToSlot(ids, 'a', 1);

/** Content that reacts: children as a function of the state, and the hook
 *  for a component deeper inside. Every field is there to read. */
function Detail(): React.ReactElement {
  const state: ReorderItemState = useReorderItem();
  const { id, dragging, lifted, disabled, edge, accepted, preview } = state;
  return (
    <text>
      {String(id)} {String(dragging || lifted || disabled)} {edge ?? ''}{' '}
      {String(accepted)} {String(preview)}
    </text>
  );
}

export const reacting = (
  <ReorderList>
    <ReorderItem id="a">
      {(state) => (
        <text
          style={{
            color: state.dragging && !state.accepted ? '$danger' : '$text',
          }}
        >
          {state.preview ? 'ghost' : 'item'}
        </text>
      )}
    </ReorderItem>
    <ReorderItem id="b">
      <Detail />
    </ReorderItem>
  </ReorderList>
);

/** The rungs added after the first cut: the gesture's own events, a
 *  conditional target, merging, a copy palette, a selection, the ghost's
 *  size and the drop flight. */
export const everything = (
  <ReorderList
    id="todo"
    group="board"
    selected={['a', 2]}
    combine
    canDrop={(q: ReorderDropQuery) =>
      q.combine === null && q.index > 0 && q.ids.length < 3 && q.source !== null
    }
    onCombine={(e: ReorderCombine) => void [e.into, e.index, e.source.list]}
    onDragStart={(e: ReorderDragStart) => void [e.id, e.ids, e.index, e.input]}
    onDragUpdate={(e: ReorderDragUpdate) =>
      void [e.over?.list, e.over?.index, e.combine]
    }
    onDragEnd={(e: ReorderDragEnd) => void [e.reason, e.to?.index]}
    onInsert={(e) => void (e.action === 'copy')}
    previewSize={{ width: 120, height: 32 }}
    dropAnimation={220}
  >
    <ReorderItem id="a" dragActions={['copy']} dragFromInteractive>
      {(s) => <text>{`${s.combining} ${s.accepted} ${s.ids.length}`}</text>}
    </ReorderItem>
  </ReorderList>
);

/** `previewSize` is a size or a function of the state. */
export const sizes: ReorderPreviewSize[] = [
  { width: 10, height: 10 },
  (state: ReorderItemState) => ({ width: state.ids.length * 40, height: 30 }),
];

/** `dropAnimation` is a switch or a duration. */
export const drops: ReorderListProps['dropAnimation'][] = [true, false, 120];

/** The input union is closed. */
export const inputs: ReorderInput[] = ['pointer', 'keyboard'];
// @ts-expect-error -- a drag comes from a pointer or a keyboard, nothing else
export const badInput: ReorderInput = 'touch';

/** The set helpers are exported beside the single-item ones. */
export const set = moveManyToSlot(['a', 'b', 'c'], ['a', 'c'], 3, 'a');
export const arrived = insertManyAtSlot(['a'], ['x', 'y'], 1);
