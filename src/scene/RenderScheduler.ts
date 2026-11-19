import * as THREE from 'three';
import type { ViewMode } from './Selection.js';

/**
 * Render on demand. The frame loop runs its logic at most `maxFps` times a
 * second, and renders only when something moved (figures, camera, scene) or
 * someone asked for a frame. Without either it renders once per
 * `idleIntervalMs`, so slow changes (a board text, a label) still show.
 */
export interface RenderSchedulerOptions {
  maxFps?: number;
  idleIntervalMs?: number;
}

/** A display refresh arrives a little early or late; this much early still counts. */
const FRAME_TOLERANCE_MS = 2;

export class RenderScheduler {
  readonly frameMs: number;
  readonly idleIntervalMs: number;
  private lastTick = -Infinity;
  private lastRender = -Infinity;
  private requested = true;

  constructor(options: RenderSchedulerOptions = {}) {
    this.frameMs = 1000 / (options.maxFps ?? 30);
    this.idleIntervalMs = options.idleIntervalMs ?? 1000;
  }

  /** Ask for one frame soon: input, a poll, a resize. */
  request(): void {
    this.requested = true;
  }

  /** True when this animation frame runs the logic (the fps cap). */
  shouldTick(now: number): boolean {
    if (now - this.lastTick < this.frameMs - FRAME_TOLERANCE_MS) return false;
    this.lastTick = now;
    return true;
  }

  /** True when this tick renders: something moved, a frame was asked for, or the idle interval passed. */
  shouldRender(now: number, active: boolean): boolean {
    if (!active && !this.requested && now - this.lastRender < this.idleIntervalMs) return false;
    this.requested = false;
    this.lastRender = now;
    return true;
  }
}

export interface RenderQuality {
  pixelRatio: number;
  shadowType: THREE.ShadowMapType;
}

/** First person keeps the full look. The overview sees the office from far: fewer pixels, hard shadows. */
export function renderQuality(mode: ViewMode, devicePixelRatio: number): RenderQuality {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return mode === 'overview'
    ? { pixelRatio: Math.min(dpr, 1.5), shadowType: THREE.BasicShadowMap }
    : { pixelRatio: Math.min(dpr, 2), shadowType: THREE.PCFShadowMap };
}

/** The view frustum of each shadow-casting light, to know whether a moving figure changes a shadow map. */
export function shadowFrustums(scene: THREE.Object3D): THREE.Frustum[] {
  const frustums: THREE.Frustum[] = [];
  scene.traverse((object) => {
    const light = object as THREE.SpotLight;
    if (!light.isLight || !light.castShadow || !light.shadow) return;
    light.updateMatrixWorld();
    light.target?.updateMatrixWorld();
    light.shadow.updateMatrices(light);
    frustums.push(light.shadow.getFrustum().clone());
  });
  return frustums;
}

const FIGURE_REACH = new THREE.Sphere(new THREE.Vector3(), 1.6);

/** True when one of the figures stands where a shadow-casting light sees it. */
export function inShadowReach(frustums: THREE.Frustum[], figures: THREE.Object3D[]): boolean {
  for (const figure of figures) {
    figure.getWorldPosition(FIGURE_REACH.center);
    FIGURE_REACH.center.y += 1;
    if (frustums.some((frustum) => frustum.intersectsSphere(FIGURE_REACH))) return true;
  }
  return false;
}

const LABEL_MARGIN = 1.15;
const projected = new THREE.Vector3();

/**
 * Run `render` (the CSS2D label renderer) with the labels outside the screen
 * hidden, so it neither moves nor sorts them. Their own visibility comes back after.
 */
export function renderOnScreenLabels(scene: THREE.Object3D, camera: THREE.Camera, render: () => void): number {
  const hidden: THREE.Object3D[] = [];
  let onScreen = 0;
  scene.traverseVisible((object) => {
    if (!(object as { isCSS2DObject?: boolean }).isCSS2DObject) return;
    projected.setFromMatrixPosition(object.matrixWorld).project(camera);
    const inside = projected.z >= -1 && projected.z <= 1
      && Math.abs(projected.x) <= LABEL_MARGIN && Math.abs(projected.y) <= LABEL_MARGIN;
    if (inside) onScreen++;
    else hidden.push(object);
  });
  for (const object of hidden) object.visible = false;
  try {
    render();
  } finally {
    for (const object of hidden) object.visible = true;
  }
  return onScreen;
}

/** `?debug=1` exposes render statistics as `window.__officeStats`. */
export function isDebugMode(search: string): boolean {
  return new URLSearchParams(search).get('debug') === '1';
}

const STATS_WINDOW = 600;

/** Render statistics for the debug read: draw calls, render times, frame intervals. */
export class FrameStats {
  renders = 0;
  ticks = 0;
  shadowUpdates = 0;
  lastCalls = 0;
  maxCalls = 0;
  lastTriangles = 0;
  labelsOnScreen = 0;
  readonly renderMs: number[] = [];
  readonly intervalsMs: number[] = [];
  private lastRenderAt = -1;

  tick(): void {
    this.ticks++;
  }

  record(now: number, renderMs: number, calls: number, triangles: number, shadowUpdate: boolean): void {
    this.renders++;
    if (shadowUpdate) this.shadowUpdates++;
    this.lastCalls = calls;
    this.maxCalls = Math.max(this.maxCalls, calls);
    this.lastTriangles = triangles;
    push(this.renderMs, renderMs);
    if (this.lastRenderAt >= 0) push(this.intervalsMs, now - this.lastRenderAt);
    this.lastRenderAt = now;
  }
}

function push(list: number[], value: number): void {
  list.push(Math.round(value * 100) / 100);
  if (list.length > STATS_WINDOW) list.shift();
}
