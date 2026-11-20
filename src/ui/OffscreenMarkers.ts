import * as THREE from 'three';
import { offscreenMarker, projectToClip, type EdgeMarker, type Rect } from '../scene/OffscreenMarker.js';
import { attentionBand, oldestFreshWait, type Wait } from './attention.js';

export interface OffscreenAgent {
  id: string;
  /** The figure's group (world position, since it may be nested). */
  object: THREE.Object3D;
  color: THREE.Color;
  wait?: Wait;
}

export interface OffscreenMarkersOptions {
  /** A fixed overlay, the size of the canvas, with pointer events off (the markers turn theirs back on). */
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  /** The camera that draws now: the orthographic camera in the isometric view, else the perspective camera. */
  camera: () => THREE.Camera;
  onSelect: (agentId: string) => void;
  /** A rect to avoid, in canvas-local pixels (for example the side panel), so a marker never sits under it. Without one, markers only clamp to the canvas edge. */
  avoid?: () => Rect | null;
}

const MARKER_CLASS = 'offscreen-marker';
const CLUSTER_CLASS = 'offscreen-marker-cluster';
const MARKER_SIZE_PX = 28;
/** Two markers closer than this (center to center, in pixels) merge into one, with a count. */
const CLUSTER_SPACING_PX = MARKER_SIZE_PX + 6;

interface Candidate {
  id: string;
  point: EdgeMarker;
  color: THREE.Color;
  wait: Wait;
}

/**
 * Arrows at the screen edge for agents with a fresh wait (AC3) that are
 * outside the frame (AC1), in every camera mode. A click flies to the agent
 * and selects it (AC2), through the same selection the agent cards use.
 * Markers that would land on top of each other merge into one, with a count;
 * the merged marker flies to its oldest fresh wait on click.
 */
export class OffscreenMarkers {
  private elements = new Map<string, HTMLButtonElement>();
  private position = new THREE.Vector3();

  constructor(private options: OffscreenMarkersOptions) {}

  /** Recompute marker positions. Call once per rendered frame; cheap, and a no-op with no fresh waits. */
  refresh(agents: OffscreenAgent[]): void {
    const rect = this.options.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      this.clear();
      return;
    }
    const camera = this.options.camera();
    const avoid = this.options.avoid?.() ?? null;
    const candidates: Candidate[] = [];
    for (const agent of agents) {
      if (attentionBand(agent.wait) !== 'fresh') continue;
      agent.object.getWorldPosition(this.position);
      const projection = projectToClip(this.position, camera);
      const point = offscreenMarker(projection, rect.width, rect.height, undefined, avoid);
      if (!point) continue;
      candidates.push({ id: agent.id, point, color: agent.color, wait: agent.wait });
    }

    const present = new Set<string>();
    for (const cluster of clusterBySpacing(candidates)) {
      if (cluster.length === 1) {
        const only = cluster[0];
        present.add(only.id);
        this.showMarker(only.id, only.point, only.color, () => this.options.onSelect(only.id));
        continue;
      }
      const primary = oldestFreshWait(cluster.map((c) => ({ id: c.id, extras: c.wait })))!;
      const anchor = cluster.find((c) => c.id === primary.id)!;
      const key = `cluster:${primary.id}`;
      present.add(key);
      this.showCluster(key, anchor.point, anchor.color, cluster.length, () => this.options.onSelect(primary.id));
    }

    for (const [key, element] of this.elements) {
      if (present.has(key)) continue;
      element.remove();
      this.elements.delete(key);
    }
  }

  /** Drop every marker, for example when the agent list goes empty. */
  clear(): void {
    for (const element of this.elements.values()) element.remove();
    this.elements.clear();
  }

  private showMarker(key: string, point: EdgeMarker, color: THREE.Color, onClick: () => void): void {
    const element = this.elements.get(key) ?? this.createElement(key);
    element.classList.remove(CLUSTER_CLASS);
    element.textContent = '';
    element.title = 'Fly to this agent';
    element.style.transform = `translate(${point.x - MARKER_SIZE_PX / 2}px, ${point.y - MARKER_SIZE_PX / 2}px) rotate(${(point.angle * 180) / Math.PI}deg)`;
    element.style.setProperty('--agent-color', `#${color.getHexString()}`);
    element.onclick = onClick;
  }

  private showCluster(key: string, point: EdgeMarker, color: THREE.Color, count: number, onClick: () => void): void {
    const element = this.elements.get(key) ?? this.createElement(key);
    element.classList.add(CLUSTER_CLASS);
    element.textContent = String(count);
    element.title = `Fly to the oldest of ${count} fresh waits here`;
    element.style.transform = `translate(${point.x - MARKER_SIZE_PX / 2}px, ${point.y - MARKER_SIZE_PX / 2}px)`;
    element.style.setProperty('--agent-color', `#${color.getHexString()}`);
    element.onclick = onClick;
  }

  private createElement(key: string): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = MARKER_CLASS;
    this.options.container.appendChild(element);
    this.elements.set(key, element);
    return element;
  }
}

interface Group<T> {
  members: T[];
  /** Where the group draws: the oldest fresh wait's own point, recomputed on every merge. */
  point: EdgeMarker;
}

/**
 * Group candidates by the point each group actually displays (the oldest
 * fresh wait's own point), not by whichever candidate arrived first. Two
 * groups merge whenever their current displayed points collide, and the
 * merge may change which point the combined group displays next — so the
 * check repeats until no two displayed points collide, however many rounds
 * that takes. Comparing only first-arrival points let two groups each look
 * clear of the other, while the points they actually drew sat on top of
 * each other.
 */
export function clusterBySpacing<T extends { id: string; point: EdgeMarker; wait: Wait }>(candidates: T[]): T[][] {
  const groups: Group<T>[] = candidates.map((candidate) => ({ members: [candidate], point: candidate.point }));
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < groups.length && !merged; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (!collide(groups[i].point, groups[j].point)) continue;
        const members = [...groups[i].members, ...groups[j].members];
        groups.splice(j, 1);
        groups.splice(i, 1, { members, point: displayPoint(members) });
        merged = true;
        break;
      }
    }
  }
  return groups.map((group) => group.members);
}

function collide(a: EdgeMarker, b: EdgeMarker): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < CLUSTER_SPACING_PX;
}

/** The point of the oldest fresh wait among `members`: the point a merged group displays and flies to. */
function displayPoint<T extends { id: string; point: EdgeMarker; wait: Wait }>(members: T[]): EdgeMarker {
  const primary = oldestFreshWait(members.map((member) => ({ id: member.id, extras: member.wait })))!;
  return members.find((member) => member.id === primary.id)!.point;
}
