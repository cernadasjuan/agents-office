import * as THREE from 'three';
import { getToonMaterial } from '../../utils/Materials.js';
import { Colors } from '../../utils/Colors.js';
import { MONITOR_A_OFFSET, MONITOR_BEZEL_MARGIN, MONITOR_HEIGHT, MONITOR_WIDTH, monitorPose, monitorWorldCorners } from './deskGeometry.js';
import { triageQueue } from '../../ui/attention.js';
import { registerExtension, type OfficeExtension, type World } from '../../extensions.js';
import type { ManagedAgent } from '../../agents/AgentManager.js';

/**
 * Two small monitors on the user's own desk (issue #161, SBE-35 updated): a mirror of the
 * personal Jira board (#145, opt-in, off without credentials) and a mirror of the triage
 * panel's waiting list (core, always available). Canvas textures, the same cheap pattern as
 * the Jira wall board (`plugins/jira/client.ts`) and the GitHub cards: a frame mesh plus one
 * textured face, never merged into the static batch (a dynamic texture redraws). Where they
 * sit and face is `deskGeometry.ts`'s own job — this file only draws and mounts them.
 *
 * The office room is always the first rented room (`room-0-office`, `rooms.ts`'s own naming;
 * the Jira wall board makes the same assumption for its slot). Without that room in the scene
 * yet, neither monitor mounts (rule 3, graceful degradation) — the same guard the Jira board
 * itself uses.
 */

const OFFICE_ROOM_NAME = 'room-0-office';
const MONITOR_CANVAS = { width: 360, height: 220 };
const MAX_ROWS = 5;

export { monitorWorldCorners };

function canvasEl(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

function fittedText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Draws a small list screen: a title, up to `MAX_ROWS` rows, or `empty` without any. */
export function drawMiniBoard(target: HTMLCanvasElement, title: string, rows: string[], empty: string): void {
  const ctx = target.getContext('2d');
  if (!ctx) return;
  const { width, height } = target;
  ctx.fillStyle = '#1d2733';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#eef3f8';
  // Issue #161 review round 2: a larger font throughout, now that the monitor itself is a
  // little bigger too — it reads from the desk camera's own distance, not a close-up crop.
  ctx.font = 'bold 26px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(title, 12, 10);
  if (rows.length === 0) {
    ctx.fillStyle = '#8ea0b2';
    ctx.font = '18px sans-serif';
    ctx.fillText(empty, 12, 48);
    return;
  }
  const top = 46;
  const rowHeight = 32;
  const shown = rows.slice(0, MAX_ROWS);
  shown.forEach((row, i) => {
    const y = top + i * rowHeight;
    ctx.fillStyle = i % 2 === 0 ? '#263340' : '#1d2733';
    ctx.fillRect(4, y, width - 8, rowHeight - 3);
    ctx.fillStyle = '#eef3f8';
    ctx.font = '18px sans-serif';
    ctx.fillText(fittedText(ctx, row, width - 24), 12, y + 7);
  });
  if (rows.length > shown.length) {
    ctx.fillStyle = '#8ea0b2';
    ctx.font = '14px sans-serif';
    ctx.fillText(`+${rows.length - shown.length} more`, 12, top + shown.length * rowHeight + 4);
  }
}

interface MountedMonitor {
  group: THREE.Group;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  disposables: Array<{ dispose(): void }>;
  signature: string;
}

function disposeAll(items: Array<{ dispose(): void }>): void {
  for (const item of items) item.dispose();
}

function buildMonitor(a: number): MountedMonitor {
  const { position, rotationY } = monitorPose(a);
  const group = new THREE.Group();
  group.position.copy(position);
  group.rotation.y = rotationY;

  const bezelGeometry = new THREE.BoxGeometry(MONITOR_WIDTH + MONITOR_BEZEL_MARGIN * 2, MONITOR_HEIGHT + MONITOR_BEZEL_MARGIN * 2, 0.03);
  const bezelMaterial = getToonMaterial(Colors.monitor);
  const bezel = new THREE.Mesh(bezelGeometry, bezelMaterial);
  group.add(bezel);

  const canvas = canvasEl(MONITOR_CANVAS.width, MONITOR_CANVAS.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const faceGeometry = new THREE.PlaneGeometry(MONITOR_WIDTH, MONITOR_HEIGHT);
  const faceMaterial = new THREE.MeshBasicMaterial({ map: texture });
  const face = new THREE.Mesh(faceGeometry, faceMaterial);
  face.position.z = 0.02;
  group.add(face);

  return { group, texture, canvas, signature: '', disposables: [bezelGeometry, faceGeometry, faceMaterial, texture] };
}

export class DeskMonitorsExtension implements OfficeExtension {
  readonly id = 'desk-monitors';
  private scene: THREE.Scene | null = null;
  /** Left: the triage panel's waiting-list mirror (core, always on). */
  private waiting: MountedMonitor | null = null;
  /** Right: the personal Jira board's mirror (issue #145, opt-in, off without data). */
  private jira: MountedMonitor | null = null;
  private waitingRows: string[] = [];
  private jiraRows: string[] = [];

  start(scene: THREE.Scene): void {
    this.scene = scene;
  }

  private officeReady(): boolean {
    return !!this.scene?.getObjectByName(OFFICE_ROOM_NAME);
  }

  agentsChanged(agents: ManagedAgent[]): void {
    const queue = triageQueue(agents.map((managed) => managed.info));
    this.waitingRows = queue.map((agent) => agent.name);
    this.redraw();
  }

  worldChanged(world: World): void {
    const tickets = world.jiraTickets ?? [];
    this.jiraRows = tickets.map((ticket) => `${ticket.key} ${ticket.status ? `(${ticket.status})` : ''}`.trim());
    this.redraw();
  }

  private redraw(): void {
    if (!this.scene || !this.officeReady()) {
      this.unmount();
      return;
    }
    // Left monitor: the waiting list, always shown (core data, rule 3 does not apply — there is
    // always a queue to report, even when it is empty).
    if (!this.waiting) {
      this.waiting = buildMonitor(-MONITOR_A_OFFSET);
      this.scene.add(this.waiting.group);
    }
    const waitingSignature = JSON.stringify(this.waitingRows);
    if (this.waiting.signature !== waitingSignature) {
      drawMiniBoard(this.waiting.canvas, 'Waiting', this.waitingRows, 'Nobody is waiting');
      this.waiting.texture.needsUpdate = true;
      this.waiting.signature = waitingSignature;
    }

    // Right monitor: the Jira mirror, only while there is Jira data to show (rule 3, the same
    // graceful degradation the wall board itself uses: off without credentials or an empty sprint).
    if (this.jiraRows.length === 0) {
      if (this.jira) this.unmountJira();
      return;
    }
    if (!this.jira) {
      this.jira = buildMonitor(MONITOR_A_OFFSET);
      this.scene.add(this.jira.group);
    }
    const jiraSignature = JSON.stringify(this.jiraRows);
    if (this.jira.signature !== jiraSignature) {
      drawMiniBoard(this.jira.canvas, 'My sprint', this.jiraRows, '');
      this.jira.texture.needsUpdate = true;
      this.jira.signature = jiraSignature;
    }
  }

  private unmountJira(): void {
    if (!this.jira) return;
    this.jira.group.removeFromParent();
    disposeAll(this.jira.disposables);
    this.jira = null;
  }

  private unmount(): void {
    if (this.waiting) {
      this.waiting.group.removeFromParent();
      disposeAll(this.waiting.disposables);
      this.waiting = null;
    }
    this.unmountJira();
  }
}

registerExtension(new DeskMonitorsExtension());
