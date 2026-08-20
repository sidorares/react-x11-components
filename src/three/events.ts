// Pointer events for the scene: X mouse events on the `<glarea>`'s child
// window, raycast against the CPU-side geometry, dispatched to the object
// they hit and bubbled up its ancestors — a port of react-x11's
// `src/pointer3d.js` onto the object graph, with the event shaped the way
// r3f handlers expect (`object`, `point`, `distance`, `stopPropagation`).
import type { Mesh, Object3D, Scene } from './objects.js';
import { raycast } from './raycast.js';
import type { RayHit } from './raycast.js';
import type { FrameCamera } from './renderer-indirect.js';

/** What a pointer handler receives. */
export interface ThreeEvent {
  type: string;
  /** The object whose handler is running (bubbling walks ancestors). */
  target: Object3D | null;
  /** The mesh the ray hit. */
  object: Mesh | null;
  point: [number, number, number] | null;
  distance: number | null;
  face: number | null;
  uv: [number, number] | null;
  x: number | undefined;
  y: number | undefined;
  nativeEvent: unknown;
  stopPropagation(): void;
  readonly propagationStopped: boolean;
}

interface NativeMouse {
  x: number;
  y: number;
}

/** The window seam this needs — what an ntk window provides. */
export interface PointerSource {
  on(name: string, handler: (event: NativeMouse) => void): unknown;
  setCursor?(cursor: string | null): void;
}

/** The dispatch path: the object that was hit, then its ancestors. */
function bubblePath(node: Object3D, scene: Scene): Object3D[] {
  const path: Object3D[] = [];
  for (
    let n: Object3D | null = node;
    n && (n as unknown) !== (scene as unknown);
    n = n.parent
  ) {
    path.push(n);
  }
  return path;
}

/**
 * One canvas's pointer pipeline. The canvas attaches it to the surface's
 * child X window once anything in the scene listens; hover and press state
 * live here so enter/leave pairs and click (down and up on the same object)
 * come out right.
 */
export class ScenePointer {
  private scene: Scene;
  private cameraOf: () => FrameCamera | null;
  private onMissed: (event: ThreeEvent) => void;
  private hovered: Object3D | null = null;
  private pressed: Object3D | null = null;
  private _cursor: string | null = null;
  private source: PointerSource | null = null;
  attached = false;

  constructor(options: {
    scene: Scene;
    cameraOf: () => FrameCamera | null;
    onPointerMissed?: (event: ThreeEvent) => void;
  }) {
    this.scene = options.scene;
    this.cameraOf = options.cameraOf;
    this.onMissed = (event) => options.onPointerMissed?.(event);
  }

  attach(source: PointerSource): void {
    if (this.attached || typeof source.on !== 'function') return;
    this.attached = true;
    this.source = source;
    source.on('mousedown', (ev) => this.onPointer('pointerdown', ev));
    source.on('mouseup', (ev) => this.onPointer('pointerup', ev));
    source.on('mousemove', (ev) => this.onPointer('pointermove', ev));
    source.on('mouseout', () => this.onLeave());
  }

  /** The nearest hit under the pointer, or null. */
  private pick(ev: NativeMouse): RayHit | null {
    const camera = this.cameraOf();
    if (!camera) return null;
    const [hit] = raycast(this.scene.children, ev.x, ev.y, camera);
    return hit ?? null;
  }

  private makeEvent(
    type: string,
    hit: RayHit | null,
    native: NativeMouse | null,
    target: Object3D | null,
  ): ThreeEvent {
    let stopped = false;
    return {
      type,
      target,
      object: hit?.object ?? null,
      point: hit?.point ?? null,
      distance: hit?.distance ?? null,
      face: hit?.face ?? null,
      uv: hit?.uv ?? null,
      x: native?.x,
      y: native?.y,
      nativeEvent: native,
      stopPropagation() {
        stopped = true;
      },
      get propagationStopped() {
        return stopped;
      },
    };
  }

  /** Call `on<Name>` along the bubble path until one stops propagation. */
  private dispatch(
    name: string,
    hit: RayHit | null,
    native: NativeMouse | null,
    node: Object3D | null = hit?.object ?? null,
  ): void {
    if (!node) return;
    const prop = `on${name[0].toUpperCase()}${name.slice(1)}`;
    let event: ThreeEvent | null = null;
    for (const target of bubblePath(node, this.scene)) {
      const handler = (target.__handlers as Record<string, unknown> | null)?.[
        prop
      ];
      if (typeof handler !== 'function') continue;
      event = event ?? this.makeEvent(name.toLowerCase(), hit, native, target);
      event.target = target;
      (handler as (event: ThreeEvent) => void)(event);
      if (event.propagationStopped) break;
    }
  }

  private onPointer(type: string, native: NativeMouse): void {
    const hit = this.pick(native);
    if (type === 'pointermove') {
      this.updateHover(hit, native);
      if (hit) this.dispatch('pointerMove', hit, native);
      return;
    }
    if (type === 'pointerdown') {
      this.pressed = hit?.object ?? null;
      if (hit) this.dispatch('pointerDown', hit, native);
      else this.onMissed(this.makeEvent('pointermissed', null, native, null));
      return;
    }
    // pointerup: a click is down and up on the same object
    if (hit) this.dispatch('pointerUp', hit, native);
    if (hit && this.pressed === hit.object) {
      this.dispatch('click', hit, native);
    }
    this.pressed = null;
  }

  /** enter/leave, diffed against the object hovered last time. */
  private updateHover(hit: RayHit | null, native: NativeMouse | null): void {
    const next = hit?.object ?? null;
    if (next === this.hovered) return;
    const previous = this.hovered;
    this.hovered = next;
    if (previous) this.dispatch('pointerOut', null, native, previous);
    if (next) this.dispatch('pointerOver', hit, native);
    this.applyCursor(next);
  }

  private applyCursor(node: Object3D | null): void {
    const source = this.source;
    if (typeof source?.setCursor !== 'function') return;
    const cursor = node?.cursor ?? null;
    if (cursor === this._cursor) return;
    this._cursor = cursor;
    source.setCursor(cursor);
  }

  private onLeave(): void {
    if (!this.hovered) return;
    this.updateHover(null, null);
  }

  /** A node left the tree: drop references to it. */
  forget(node: object): void {
    if (this.hovered === node) this.hovered = null;
    if (this.pressed === node) this.pressed = null;
  }
}
