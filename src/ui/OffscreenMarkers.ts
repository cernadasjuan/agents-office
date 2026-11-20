import * as THREE from 'three';
import { offscreenMarker, projectToClip } from '../scene/OffscreenMarker.js';
import { attentionBand, type Wait } from './attention.js';

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
}

const MARKER_CLASS = 'offscreen-marker';
const MARKER_SIZE_PX = 28;

/**
 * Arrows at the screen edge for agents with a fresh wait (AC3) that are
 * outside the frame (AC1), in every camera mode. A click flies to the agent
 * and selects it (AC2), through the same selection the agent cards use.
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
    const present = new Set<string>();
    for (const agent of agents) {
      if (attentionBand(agent.wait) !== 'fresh') continue;
      agent.object.getWorldPosition(this.position);
      const clip = projectToClip(this.position, camera);
      const marker = offscreenMarker(clip, rect.width, rect.height);
      if (!marker) continue;
      present.add(agent.id);
      const element = this.elements.get(agent.id) ?? this.createElement(agent.id);
      element.style.transform = `translate(${marker.x - MARKER_SIZE_PX / 2}px, ${marker.y - MARKER_SIZE_PX / 2}px) rotate(${(marker.angle * 180) / Math.PI}deg)`;
      element.style.setProperty('--agent-color', `#${agent.color.getHexString()}`);
    }
    for (const [id, element] of this.elements) {
      if (present.has(id)) continue;
      element.remove();
      this.elements.delete(id);
    }
  }

  /** Drop every marker, for example when the agent list goes empty. */
  clear(): void {
    for (const element of this.elements.values()) element.remove();
    this.elements.clear();
  }

  private createElement(agentId: string): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = MARKER_CLASS;
    element.title = 'Fly to this agent';
    element.addEventListener('click', () => this.options.onSelect(agentId));
    this.options.container.appendChild(element);
    this.elements.set(agentId, element);
    return element;
  }
}
