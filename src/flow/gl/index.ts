// The GL renderer's entry: what `<Flow>` loads, by dynamic import, when it is
// asked to draw through GL — and only then. A static import anywhere under
// `<Flow>` would put the shaders and the packer into every bundle that draws
// a graph; `test/treeshake.test.ts` holds it to that, as it holds `<Map>`.
//
// What is here is the surface: a `<glarea>` laid over the pane, drawing the
// pane's own scene every frame it is asked for one. It owns no graph and no
// input. The `<flowgraph>` element under it keeps both — the hit test skips a
// surface and answers with the node behind it, which is the pane — and asks
// for frames through `setGlRequest`, so every change the 2D renderer would
// have repainted becomes one GL frame.
import React, { useEffect, useLayoutEffect, useMemo } from 'react';
import type { ReactElement, ReactNode } from 'react';

import type {
  FlowFrameStats,
  FlowGlBody,
  FlowGlBodyHost,
  FlowGlTexture,
} from '../types.js';
import { FlowGlRenderer, now } from './renderer.js';
import { LabelAtlas } from './text.js';
import type { TextSource } from './text.js';
import type { FlowGlFrame, FlowGlTarget, GlBodyRequest } from './renderer.js';

/** What the surface needs of the pane — `FlowGraphNode`, structurally. */
export interface FlowGlSource {
  glFrame(
    lastKey: string | null,
    lastLifted?: string | null,
  ): (FlowGlFrame & { key: string; liftedKey?: string | null }) | null;
  glText?(): TextSource | null;
  setGlRequest(request: (() => void) | null): void;
  bodyBudget(): FlowFrameStats['bodies'];
  /** The GL body a node has now (`FlowNodeType.glBody`), or null: none, or
   *  no such node any more. */
  glBodyOf?(id: string): FlowGlBody | null;
}

/** A GL body the surface draws, and what it keeps of it between frames. */
interface BodySlot {
  body: FlowGlBody;
  host: FlowGlBodyHost;
  /** Asked for a frame since it last drew. */
  dirty: boolean;
  /** The frame it was last in view in (`FlowGlDriver.frames`): in the last one
   *  drawn is the only time its asking for a frame means one. */
  seen: number;
  /** What it last drew, and at what size it was asked for. */
  texture: FlowGlTexture | null;
  width: number;
  height: number;
  /** Threw from `draw`: drawn as its card from then on. */
  broken: boolean;
}

export interface FlowGlSurfaceProps {
  pane: { readonly current: FlowGlSource | null };
  /** The colour a frame starts from — the palette's background, so the
   *  instant before the first frame is the graph's ground, not black. */
  clearColor: string;
  onFrame?: (stats: FlowFrameStats) => void;
  /** The surface could not draw; `<Flow>` goes back to the 2D renderer. */
  onError: (error: Error) => void;
  /** Drawn over the surface: the mounted node bodies. */
  children?: ReactNode;
}

interface AreaNode {
  requestFrame?(): void;
}

/** What core's `<glarea>` hands `onDraw` (react-x11 ≥ 2.18.0 passes the
 *  display scale — sidorares/react-x11#634). */
export interface DrawInfoLike {
  width: number;
  height: number;
  scale: number;
  node: { abs: { x: number; y: number } };
}

/**
 * Where the surface sits, from what `onDraw` was handed.
 *
 * The scene is in logical window pixels and the surface is a box of its own
 * in device ones; the node's `abs` is device pixels too, so its origin in
 * logical ones is `abs / scale`. Taking `scale` from `DrawInfo`, where its
 * type puts it, made that `abs / undefined`: every vertex `NaN`, a blank
 * pane — and every counter the renderer keeps, draw calls and instances and
 * frames a second, exactly what a correct frame reports. So a target that
 * is not finite throws here, and a surface that cannot place itself fails
 * back to the 2D renderer through `onError` rather than drawing nothing.
 */
export function targetOf(info: DrawInfoLike): FlowGlTarget {
  const scale = info.scale;
  const target = {
    origin: { x: info.node.abs.x / scale, y: info.node.abs.y / scale },
    scale,
    width: info.width,
    height: info.height,
  };
  if (
    ![
      target.origin.x,
      target.origin.y,
      scale,
      target.width,
      target.height,
    ].every(Number.isFinite) ||
    !(scale > 0)
  ) {
    throw new Error(
      `@react-x11/components flow/gl: cannot place the surface ` +
        `(${JSON.stringify(target)})`,
    );
  }
  return target;
}

/** Slices of setting — a few milliseconds of fields, and the batch drawn
 *  and read back that an engine without coverage of its own needs — one
 *  run may take: a bound, so a screen whose labels outgrow the atlas does
 *  not set labels for ever. The next frame that wants any starts another. */
const MAX_SLICES = 64;

/** The surface's state across renders: the renderer lives as long as the GL
 *  context it was made for, which is longer than any one props object.
 *  Exported for the tests that drive a frame by hand against a recording GL
 *  table, as `<Map>`'s `GlMapDriver` is. */
export class FlowGlDriver {
  props: FlowGlSurfaceProps;
  private area: AreaNode | null = null;
  private renderer: FlowGlRenderer | null = null;
  private context: unknown = null;
  /** The key of the world now on the GPU — null when there is none, which
   *  is what makes the next frame build one. */
  private worldKey: string | null = null;
  /** The same for the lifted layer — the nodes a drag is moving. */
  private liftedKey: string | null = null;
  /** The label atlas, and the face and scale it was made for: either
   *  changing is every field wrong, so it is made again. */
  private atlas: LabelAtlas | null = null;
  private atlasKey = '';
  /** The timer that brings a frame once a zoom gesture stops — strings it
   *  uncovered are only set at rest, and a gesture that rebuilt its world
   *  on the way asks for no frame by itself when it stops. */
  private settle: unknown = null;
  private failed = false;
  /** Labels are being set (`setLabels`); one run at a time. */
  private setting = false;
  /** The GL bodies this surface has drawn, by node id (`renderBodies`). */
  private readonly slots = new Map<string, BodySlot>();
  /** The context `draw` was last handed, for the bodies' frames. */
  private bodyGl: unknown = null;
  /** Frames drawn, counted — what a body's `seen` is measured against. */
  private frames = 0;

  constructor(props: FlowGlSurfaceProps) {
    this.props = props;
  }

  /** Stable, so the pane can compare it and not repaint on every render. */
  readonly request = (): void => {
    this.area?.requestFrame?.();
  };

  readonly areaRef = (node: AreaNode | null): void => {
    this.area = node;
    this.attach();
  };

  attach(): void {
    this.props.pane.current?.setGlRequest(
      this.area && !this.failed ? this.request : null,
    );
  }

  detach(): void {
    this.props.pane.current?.setGlRequest(null);
    this.detachBodies();
    if (this.settle != null) timers.clearTimeout?.(this.settle);
    this.settle = null;
    this.atlas?.dispose();
    this.atlas = null;
    this.atlasKey = '';
  }

  readonly draw = (gl: unknown, info: DrawInfoLike): void => {
    if (this.failed) return;
    try {
      if (this.context !== gl || !this.renderer) {
        // A new context is new everything: programs and buffers belong to
        // the one they were made in.
        this.renderer = new FlowGlRenderer(gl);
        this.context = gl;
        this.worldKey = null;
        this.liftedKey = null;
      }
      const pane = this.props.pane.current;
      if (!pane) return;
      const atlas = this.atlasFor(pane);
      const started = now();
      const frame = pane.glFrame(this.worldKey, this.liftedKey);
      if (!frame) return;
      const sceneMs = now() - started;
      const target = targetOf(info);
      if (atlas) {
        this.admit(atlas, frame.moving ?? false);
        // the view, in the world's coordinates
        const zoom = frame.zoom ?? 1;
        atlas.setView({
          x: (target.origin.x - frame.offset.x) / zoom,
          y: (target.origin.y - frame.offset.y) / zoom,
          width: target.width / target.scale / zoom,
          height: target.height / target.scale / zoom,
        });
      }
      this.bodyGl = gl;
      this.frames++;
      const stats = this.renderer.drawFrame(
        pane.glBodyOf ? { ...frame, bodies: this.renderBodies } : frame,
        target,
        atlas ?? undefined,
      );
      this.pruneBodies();
      if (frame.world) this.worldKey = frame.key;
      if (frame.lifted !== undefined) this.liftedKey = frame.liftedKey ?? null;
      // Labels this frame could not draw yet are set now, between frames.
      if (atlas?.wanting && !this.setting) {
        this.setting = true;
        this.setLabels(atlas).then(
          () => (this.setting = false),
          (error: unknown) => {
            this.setting = false;
            this.fail(error);
          },
        );
      }
      this.props.onFrame?.({
        renderer: 'gl',
        sceneMs,
        ...stats,
        bodies: pane.bodyBudget(),
      });
    } catch (error) {
      this.fail(error);
    }
  };

  /**
   * Set strings until nothing the world on screen draws is wanted, a frame
   * after every slice that set any: the world holds a box for every label,
   * the ones still being set drawn as nothing, and the frame writes in what
   * landed (`FlowGlRenderer.landLabels`). The labels arrive as they are
   * set, nearest the middle of the view first, where they used to wait for
   * the last of them and a world packed again.
   *
   * Stops when the zoom starts moving again, or after a bound on slices.
   */
  private async setLabels(atlas: LabelAtlas): Promise<void> {
    for (let slice = 0; slice < MAX_SLICES; slice++) {
      const set = await atlas.pump();
      if (this.failed || this.atlas !== atlas) return;
      if (!set) break;
      this.request();
      if (!atlas.wanting) break;
    }
  }

  /** The atlas for this pane's face and scale, made again when either
   *  changes — and dropped where there is no text engine at all. */
  private atlasFor(pane: FlowGlSource): LabelAtlas | null {
    const text = pane.glText?.() ?? null;
    if (!text) return null;
    const key = `${text.options.family}|${text.options.scale}`;
    if (!this.atlas || key !== this.atlasKey) {
      this.atlas?.dispose();
      this.atlas = new LabelAtlas(text);
      this.atlasKey = key;
      this.worldKey = null;
      this.liftedKey = null;
    }
    return this.atlas;
  }

  /**
   * New strings only while no zoom gesture moves, and a frame asked for once
   * it has stopped, so the labels it uncovered are set without a nudge. A
   * gesture is the pane's to say (`FlowGlFrame.moving`): a single step — a
   * button, `fitView`, `setCenter` — is not one. Taking any change of zoom
   * for one held every first appearance back by the whole rest timer: the
   * stress fan's first label came 185 ms after a `setCenter`, and comes at
   * 54.
   */
  private admit(atlas: LabelAtlas, moving: boolean): void {
    atlas.admit = !moving;
    if (moving) this.settleSoon();
  }

  /** A frame once the zoom gesture under way has stopped — 120 ms after
   *  the last frame that found it moving. */
  private settleSoon(): void {
    if (this.settle != null) timers.clearTimeout?.(this.settle);
    this.settle = timers.setTimeout?.(() => {
      this.settle = null;
      this.request();
    }, 120);
  }

  /**
   * The bodies in view, drawn where they need to be: one that asked for a
   * frame, one asked for at another size — the world rebuilt at another
   * zoom — and one seen for the first time. Every other in view answers the
   * texture it drew last, so a pan draws no body: the world it is part of
   * moves, and it with it.
   *
   * Nor does a zoom gesture, while it moves: a body that has a texture is
   * drawn from it, stretched with the world, whatever it asked for or
   * whatever size it is wanted at now, and is drawn again once the zoom has
   * rested — as `<Flow>` holds mounted bodies out of a zoom, and for the
   * same reason. The world is built again at a zoom twice the one it was,
   * and a map drawn again at every rebuild set its labels again at each
   * new scale: 38 frames a second of each map on screen, for pictures a
   * zoom draws stretched anyway.
   */
  readonly renderBodies = (
    inView: readonly GlBodyRequest[],
    moving: boolean,
  ): ReadonlyMap<string, FlowGlTexture> => {
    const pane = this.props.pane.current;
    const out = new Map<string, FlowGlTexture>();
    if (!pane?.glBodyOf) return out;
    for (const { id, frame } of inView) {
      const body = pane.glBodyOf(id);
      let slot = this.slots.get(id);
      if (slot && slot.body !== body) {
        this.slots.delete(id);
        slot.body.detach?.();
        slot = undefined;
      }
      if (!body) continue;
      if (!slot) slot = this.attachBody(id, body);
      slot.seen = this.frames;
      if (slot.broken) continue;
      const resized =
        slot.texture === null ||
        slot.width !== frame.width ||
        slot.height !== frame.height;
      if ((slot.dirty || resized) && moving && slot.texture !== null) {
        // drawn once the zoom rests, which asks for the frame that does it
        this.settleSoon();
      } else if (slot.dirty || resized) {
        slot.dirty = false;
        try {
          const texture = body.draw(this.bodyGl, frame);
          slot.texture = texture;
          slot.width = frame.width;
          slot.height = frame.height;
        } catch (error) {
          // A body is the app's: one that throws is drawn as its card, and
          // the graph — and every other body — draws on.
          slot.broken = true;
          slot.texture = null;
          warn(`a GL node body threw and is drawn as its card: ${error}`);
        }
      }
      if (slot.texture) out.set(id, slot.texture);
    }
    return out;
  };

  private attachBody(id: string, body: FlowGlBody): BodySlot {
    const slot: BodySlot = {
      body,
      dirty: true,
      seen: this.frames,
      texture: null,
      width: 0,
      height: 0,
      broken: false,
      host: {
        requestFrame: () => {
          if (this.slots.get(id) !== slot) return;
          slot.dirty = true;
          if (slot.seen === this.frames) this.request();
        },
      },
    };
    this.slots.set(id, slot);
    body.attach?.(slot.host);
    return slot;
  }

  /** Let go of the bodies whose node is gone, or whose type now names
   *  another — out of view too, which `renderBodies` never sees. */
  private pruneBodies(): void {
    if (this.slots.size === 0) return;
    const pane = this.props.pane.current;
    for (const [id, slot] of this.slots) {
      if (slot.seen === this.frames) continue;
      if (pane?.glBodyOf?.(id) === slot.body) continue;
      this.slots.delete(id);
      slot.body.detach?.();
    }
  }

  /** Every body let go: the surface is going, or has failed. */
  detachBodies(): void {
    const slots = [...this.slots.values()];
    this.slots.clear();
    for (const slot of slots) {
      try {
        slot.body.detach?.();
      } catch (error) {
        warn(`a GL node body threw as it was let go: ${error}`);
      }
    }
  }

  readonly surfaceError = (error: Error): void => {
    this.fail(error);
  };

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.detach();
    this.props.onError(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/**
 * Over the pane's box, and **transparent to the pointer**.
 *
 * Core hit-tests a window's surfaces before its tree (`GlAreaNode.hitSurface`
 * in react-x11): a point over a `<glarea>` is over *it*, whatever sits behind
 * in the tree. Everything a graph editor does with the pointer lives on the
 * pane underneath, so without this a press on a card landed on the surface,
 * which has no handlers, and a drag did nothing at all — found by driving
 * a real drag through the Cocoa backend, which moved the node 177 px on the
 * 2D renderer and 0 on this one. `pointerEvents: 'none'` is core's own way
 * to say a node is for looking at, and it lets the pointer through to the
 * pane as it would through any node.
 *
 * With node bodies over it the surface is `'box-none'` instead (below): the
 * bodies take the pointer, and the surface between them still passes it on
 * to the pane. Making the surface the pane's child, as `<Map>`'s is, would
 * not have done: the pane's gestures are default actions, and core runs a
 * default action on the event's target alone, never an ancestor.
 */
/** Timers, through `globalThis`: `src/` compiles with `types: []`. */
const timers = globalThis as {
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
  process?: { env?: Record<string, string | undefined> };
  console?: { warn(message: string): void };
};

/** A development warning, once per message — production says nothing. */
const warned = new Set<string>();
function warn(message: string): void {
  if (timers.process?.env?.NODE_ENV === 'production' || warned.has(message)) {
    return;
  }
  warned.add(message);
  timers.console?.warn(`@react-x11/components <Flow>: ${message}`);
}

const FILL = {
  position: 'absolute',
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  pointerEvents: 'none',
} as const;

/** The same, where the surface holds node bodies: they are its children,
 *  drawn over it, and take the pointer; the surface between them still does
 *  not. React Native's `'box-none'`, which react-x11 has from #637 on. */
const FILL_WITH_BODIES = { ...FILL, pointerEvents: 'box-none' } as const;

/**
 * The surface. Mounted by `<Flow>` as the pane's sibling, after it, filling
 * the same box: a `<glarea>` is stacked over everything 2D in its window, so
 * it lands on the pane wherever it is in the tree.
 */
export function FlowGlSurface(props: FlowGlSurfaceProps): ReactElement {
  const driver = useMemo(() => new FlowGlDriver(props), []);
  driver.props = props;
  useEffect(() => {
    driver.attach();
    return () => driver.detach();
  }, [driver]);
  // The bodies are let go in the commit that takes the surface away, before
  // core destroys the <glarea> and its context: what a body made in it is
  // deleted while there is a context to delete it from — the arrangement
  // `<Map>`'s own GL pane makes for its buffers.
  useLayoutEffect(() => () => driver.detachBodies(), [driver]);
  return React.createElement('glarea', {
    ref: driver.areaRef,
    // With bodies over it, the surface must pass the pointer through between
    // them and still let them take it — `'box-none'`, react-x11#637. With
    // none, `'none'` does the same and needs nothing new of core.
    style: props.children ? FILL_WITH_BODIES : FILL,
    clearColor: props.clearColor,
    frameLoop: 'demand',
    onDraw: driver.draw,
    onError: driver.surfaceError,
    children: props.children,
  });
}
