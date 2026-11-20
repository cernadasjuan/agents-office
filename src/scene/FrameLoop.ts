import * as THREE from 'three';
import type { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { FigureBatch } from '../characters/FigureBatch.js';
import { casterSignature, countDrawCalls } from './RenderBudget.js';
import { FrameStats, RenderScheduler, inShadowReach, renderOnScreenLabels, renderQuality, shadowFrustums } from './RenderScheduler.js';
import { isViewFromAbove, type ViewMode } from './Selection.js';
import { sleepUnseenFigures } from './AnimationSleep.js';
import { StaticBatch } from './StaticMerge.js';
import { applyCeilingCut, applyCutaway, findCeilings } from './Cutaway.js';

export interface FrameLoopOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** The camera that draws now (the isometric view draws through an orthographic camera). Default: `camera`. */
  activeCamera?(): THREE.Camera;
  renderer: Pick<THREE.WebGLRenderer, 'render' | 'info' | 'shadowMap' | 'getPixelRatio' | 'setPixelRatio'> & {
    /** The canvas: a WebGL context restore must redraw the shadow maps. */
    domElement?: Pick<HTMLCanvasElement, 'addEventListener'>;
  };
  labelRenderer: Pick<CSS2DRenderer, 'render'>;
  /** The per-frame logic: camera, agents, labels, extensions. */
  update(elapsed: number, delta: number): void;
  /** The figure roots to draw through the figure batch. */
  figures(): THREE.Object3D[];
  mode(): ViewMode;
  /** Something the loop cannot see moves (the selection ring pulses). */
  animating?(): boolean;
  /** Where input arrives; input asks for a frame at once. */
  events?: Pick<Window, 'addEventListener'>;
  devicePixelRatio?(): number;
  stats?: FrameStats | null;
}

const WAKE_EVENTS = ['pointermove', 'pointerdown', 'wheel', 'keydown', 'keyup', 'resize'];
/** An idle sway (a pose change in place) redraws the shadow maps at most this often. */
export const IDLE_SHADOW_INTERVAL_MS = 500;
const POSITION_EPSILON = 1e-4;

/** What moved in a shadow map's reach: a walk or turn (redraw now), or only a pose in place (redraw soon). */
interface CasterMoves {
  real: boolean;
  idle: boolean;
}

/**
 * The render loop. Static furniture draws merged, figures draw instanced, the
 * shadow maps redraw only when a caster changes (an idle sway at most twice a
 * second), figures out of view or far sleep, and frames render on demand at
 * most 30 times a second (once a second when nothing moves).
 */
export class FrameLoop {
  readonly scheduler = new RenderScheduler();
  readonly staticBatch: StaticBatch;
  readonly figureBatch: FigureBatch;
  private startedAt: number | null = null;
  private lastNow = 0;
  private lastMode: ViewMode | null = null;
  private lastView = new THREE.Matrix4();
  private lastProjection = new THREE.Matrix4();
  private frustums: THREE.Frustum[] | null = null;
  private inReach = new WeakMap<THREE.Object3D, boolean>();
  private rootMatrices = new WeakMap<THREE.Object3D, THREE.Matrix4>();
  private shadowsDirty = true;
  private idleShadowPending = false;
  private lastShadowAt = -Infinity;
  private casters = 0;
  private ceilings: THREE.Object3D[] | null = null;

  constructor(private options: FrameLoopOptions) {
    const { scene } = options;
    // The loop updates world matrices once per tick, before the batches read them
    scene.matrixWorldAutoUpdate = false;
    this.staticBatch = new StaticBatch(scene);
    this.figureBatch = new FigureBatch(scene);
    for (const type of WAKE_EVENTS) options.events?.addEventListener(type, () => this.scheduler.request(), { passive: true });
    // A lost context loses the shadow maps; they only redraw when asked
    options.renderer.domElement?.addEventListener('webglcontextrestored', () => this.contextRestored());
    // The renderer resets its info after the shadow pass: reset it before each render so the stats count both passes
    options.renderer.info.autoReset = false;
  }

  /** The WebGL context came back: draw a frame with new shadow maps. */
  contextRestored(): void {
    this.shadowsDirty = true;
    this.scheduler.request();
  }

  /** Call after the agents or the world changed: a frame soon, and new shadows if the casters changed. */
  sceneChanged(): void {
    this.scheduler.request();
    this.ceilings = null;
    const signature = casterSignature(this.options.scene);
    if (signature !== this.casters) this.shadowsDirty = true;
    this.casters = signature;
  }

  /** One animation frame. Returns true when it rendered. */
  frame(now: number): boolean {
    if (!this.scheduler.shouldTick(now)) return false;
    const { scene, renderer, stats } = this.options;
    if (this.startedAt === null) {
      this.startedAt = now;
      this.lastNow = now;
    }
    const delta = (now - this.lastNow) / 1000;
    const elapsed = (now - this.startedAt) / 1000;
    this.lastNow = now;
    stats?.tick();

    sleepUnseenFigures(this.camera(), this.options.figures());
    this.options.update(elapsed, delta);
    // The update may switch the view and with it the camera
    const camera = this.camera();
    const modeChanged = this.applyQuality();
    const fromAbove = isViewFromAbove(this.options.mode());
    scene.updateMatrixWorld();
    const rebuilt = this.staticBatch.update();
    const cut = applyCutaway(scene, fromAbove);
    this.ceilings ??= findCeilings(scene);
    const ceilingChanged = applyCeilingCut(this.ceilings, fromAbove);
    const figures = this.figureBatch.sync(this.options.figures());
    camera.updateMatrixWorld();
    const cameraMoved = !this.lastView.equals(camera.matrixWorld) || !this.lastProjection.equals(camera.projectionMatrix);
    const active = rebuilt || cut || ceilingChanged || modeChanged || cameraMoved || figures.changed || figures.moved.length > 0 || Boolean(this.options.animating?.());
    if (!this.scheduler.shouldRender(now, active)) return false;

    const casterMoves = this.castersMoved(figures.moved);
    if (casterMoves.idle) this.idleShadowPending = true;
    const idleShadowDue = this.idleShadowPending && now - this.lastShadowAt >= IDLE_SHADOW_INTERVAL_MS;
    const shadows = rebuilt || cut || modeChanged || figures.changed || this.shadowsDirty || casterMoves.real || idleShadowDue;
    if (shadows) {
      renderer.shadowMap.needsUpdate = true;
      this.lastShadowAt = now;
      this.idleShadowPending = false;
    }
    this.shadowsDirty = false;

    const started = performance.now();
    renderer.info.reset();
    renderer.render(scene, camera);
    const calls = renderer.info.render.calls;
    const triangles = renderer.info.render.triangles;
    const labels = renderOnScreenLabels(scene, camera, () => this.options.labelRenderer.render(scene, camera));
    this.lastView.copy(camera.matrixWorld);
    this.lastProjection.copy(camera.projectionMatrix);
    if (stats) {
      stats.labelsOnScreen = labels;
      stats.record(now, performance.now() - started, calls, triangles, shadows);
    }
    return true;
  }

  start(requestFrame: (callback: (now: number) => void) => void): void {
    const loop = (now: number) => {
      requestFrame(loop);
      this.frame(now);
    };
    requestFrame(loop);
  }

  /** The static draw-call count of the current scene (debug read). */
  drawCalls() {
    return countDrawCalls(this.options.scene, this.camera());
  }

  private camera(): THREE.Camera {
    return this.options.activeCamera?.() ?? this.options.camera;
  }

  /**
   * Moved figures that are, or just were, where a shadow-casting light sees
   * them. A figure whose root moved or turned (a walk, an arrival) is a real
   * move; one whose root stayed (an idle sway) is an idle move.
   */
  private castersMoved(moved: THREE.Object3D[]): CasterMoves {
    this.frustums ??= shadowFrustums(this.options.scene);
    const result: CasterMoves = { real: false, idle: false };
    for (const figure of moved) {
      const now = inShadowReach(this.frustums, [figure]);
      const was = this.inReach.get(figure);
      this.inReach.set(figure, now);
      const rootMoved = this.rootMoved(figure);
      if (!now && !was) continue;
      if (rootMoved || now !== was) result.real = true;
      else result.idle = true;
    }
    return result;
  }

  private rootMoved(figure: THREE.Object3D): boolean {
    const last = this.rootMatrices.get(figure);
    if (!last) {
      this.rootMatrices.set(figure, figure.matrixWorld.clone());
      return true;
    }
    const moved = last.elements.some((value, i) => Math.abs(value - figure.matrixWorld.elements[i]) > POSITION_EPSILON);
    if (moved) last.copy(figure.matrixWorld);
    return moved;
  }

  /** Overview: lower pixel ratio and hard shadows. True when the view mode changed. */
  private applyQuality(): boolean {
    const mode = this.options.mode();
    if (mode === this.lastMode) return false;
    this.lastMode = mode;
    const { renderer } = this.options;
    const quality = renderQuality(mode, this.options.devicePixelRatio?.() ?? 1);
    if (renderer.getPixelRatio() !== quality.pixelRatio) renderer.setPixelRatio(quality.pixelRatio);
    renderer.shadowMap.type = quality.shadowType;
    return true;
  }
}
