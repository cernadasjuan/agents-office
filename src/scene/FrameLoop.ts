import * as THREE from 'three';
import type { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { FigureBatch } from '../characters/FigureBatch.js';
import { casterSignature, countDrawCalls } from './RenderBudget.js';
import { FrameStats, RenderScheduler, inShadowReach, renderOnScreenLabels, renderQuality, shadowFrustums } from './RenderScheduler.js';
import type { ViewMode } from './Selection.js';
import { StaticBatch } from './StaticMerge.js';
import { applyCutaway } from './Cutaway.js';

export interface FrameLoopOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: Pick<THREE.WebGLRenderer, 'render' | 'info' | 'shadowMap' | 'getPixelRatio' | 'setPixelRatio'>;
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

/**
 * The render loop. Static furniture draws merged, figures draw instanced, the
 * shadow maps redraw only when a caster changes, and frames render on demand
 * at most 30 times a second (once a second when nothing moves).
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
  private shadowsDirty = true;
  private casters = 0;

  constructor(private options: FrameLoopOptions) {
    const { scene } = options;
    // The loop updates world matrices once per tick, before the batches read them
    scene.matrixWorldAutoUpdate = false;
    this.staticBatch = new StaticBatch(scene);
    this.figureBatch = new FigureBatch(scene);
    for (const type of WAKE_EVENTS) options.events?.addEventListener(type, () => this.scheduler.request(), { passive: true });
  }

  /** Call after the agents or the world changed: a frame soon, and new shadows if the casters changed. */
  sceneChanged(): void {
    this.scheduler.request();
    const signature = casterSignature(this.options.scene);
    if (signature !== this.casters) this.shadowsDirty = true;
    this.casters = signature;
  }

  /** One animation frame. Returns true when it rendered. */
  frame(now: number): boolean {
    if (!this.scheduler.shouldTick(now)) return false;
    const { scene, camera, renderer, stats } = this.options;
    if (this.startedAt === null) {
      this.startedAt = now;
      this.lastNow = now;
    }
    const delta = (now - this.lastNow) / 1000;
    const elapsed = (now - this.startedAt) / 1000;
    this.lastNow = now;
    stats?.tick();

    this.options.update(elapsed, delta);
    const modeChanged = this.applyQuality();
    scene.updateMatrixWorld();
    const rebuilt = this.staticBatch.update();
    const cut = applyCutaway(scene, this.options.mode() === 'overview');
    const figures = this.figureBatch.sync(this.options.figures());
    camera.updateMatrixWorld();
    const cameraMoved = !this.lastView.equals(camera.matrixWorld) || !this.lastProjection.equals(camera.projectionMatrix);
    const active = rebuilt || cut || modeChanged || cameraMoved || figures.changed || figures.moved.length > 0 || Boolean(this.options.animating?.());
    if (!this.scheduler.shouldRender(now, active)) return false;

    const shadows = rebuilt || cut || modeChanged || figures.changed || this.shadowsDirty || this.castersMoved(figures.moved);
    if (shadows) renderer.shadowMap.needsUpdate = true;
    this.shadowsDirty = false;

    const started = performance.now();
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
    return countDrawCalls(this.options.scene);
  }

  /** True when a moved figure is, or just was, where a shadow-casting light sees it. */
  private castersMoved(moved: THREE.Object3D[]): boolean {
    this.frustums ??= shadowFrustums(this.options.scene);
    let touched = false;
    for (const figure of moved) {
      const now = inShadowReach(this.frustums, [figure]);
      if (now || this.inReach.get(figure)) touched = true;
      this.inReach.set(figure, now);
    }
    return touched;
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
