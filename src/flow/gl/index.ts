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
import React, { useEffect, useMemo } from 'react';
import type { ReactElement, ReactNode } from 'react';

import type { FlowFrameStats } from '../types.js';
import { FlowGlRenderer, now } from './renderer.js';
import { LabelAtlas } from './text.js';
import type { TextSource } from './text.js';
import type { FlowGlFrame, FlowGlTarget } from './renderer.js';

/** What the surface needs of the pane — `FlowGraphNode`, structurally. */
export interface FlowGlSource {
  glFrame(lastKey: string | null): (FlowGlFrame & { key: string }) | null;
  glText?(): TextSource | null;
  setGlRequest(request: (() => void) | null): void;
  bodyBudget(): FlowFrameStats['bodies'];
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

/** Slices of setting — a batch drawn and read back, or a few milliseconds
 *  of its fields — one run may take before the world is repacked with what
 *  has landed: a bound, so a screen whose labels outgrow the atlas still
 *  shows the ones that fit. */
const MAX_SLICES = 64;

/** The surface's state across renders: the renderer lives as long as the GL
 *  context it was made for, which is longer than any one props object. */
class Driver {
  props: FlowGlSurfaceProps;
  private area: AreaNode | null = null;
  private renderer: FlowGlRenderer | null = null;
  private context: unknown = null;
  /** The key of the world now on the GPU — null when there is none, which
   *  is what makes the next frame build one. */
  private worldKey: string | null = null;
  /** The label atlas, and the face and scale it was made for: either
   *  changing is every field wrong, so it is made again. */
  private atlas: LabelAtlas | null = null;
  private atlasKey = '';
  /** The zoom the last frame drew at, and the timer that brings a frame
   *  once a zoom stops — strings a zoom uncovered are only set at rest, and
   *  a pane that has stopped zooming asks for no frame by itself. */
  private lastZoom = NaN;
  private settle: unknown = null;
  private failed = false;
  /** Labels are being set (`setLabels`); one run at a time. */
  private setting = false;

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
      }
      const pane = this.props.pane.current;
      if (!pane) return;
      const atlas = this.atlasFor(pane);
      const started = now();
      const frame = pane.glFrame(this.worldKey);
      if (!frame) return;
      const sceneMs = now() - started;
      if (atlas) this.admit(atlas, frame.overlay.viewport.zoom);
      const stats = this.renderer.drawFrame(
        frame,
        targetOf(info),
        atlas ?? undefined,
      );
      if (frame.world) this.worldKey = frame.key;
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
   * Set strings until nothing the world on screen draws is wanted, then
   * repack it **once** — which is what brings the labels in, all in the
   * same frame. Repacking a batch at a time brought them in waves, and paid
   * a full world pack per wave.
   *
   * Stops early, repacking what landed, when the atlas moved its fields
   * (the world's texture coordinates are stale until it is repacked), when
   * the zoom starts moving again, or after a bound on slices.
   */
  private async setLabels(atlas: LabelAtlas): Promise<void> {
    let landed = false;
    for (let slice = 0; slice < MAX_SLICES; slice++) {
      const set = await atlas.pump();
      if (this.failed || this.atlas !== atlas) return;
      if (!set) break;
      landed = true;
      if (atlas.relocated || !atlas.wanting) break;
    }
    if (!landed) return;
    this.worldKey = null;
    this.request();
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
    }
    return this.atlas;
  }

  /** New strings only while the zoom holds still; a frame is asked for once
   *  it has, so the labels a zoom uncovered are set without a nudge. */
  private admit(atlas: LabelAtlas, zoom: number): void {
    const moving = zoom !== this.lastZoom;
    this.lastZoom = zoom;
    atlas.admit = !moving;
    if (moving) {
      if (this.settle != null) timers.clearTimeout?.(this.settle);
      this.settle = timers.setTimeout?.(() => {
        this.settle = null;
        this.request();
      }, 120);
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
};

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
  const driver = useMemo(() => new Driver(props), []);
  driver.props = props;
  useEffect(() => {
    driver.attach();
    return () => driver.detach();
  }, [driver]);
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
