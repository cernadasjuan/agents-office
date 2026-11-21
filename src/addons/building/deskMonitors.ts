import * as THREE from 'three';
import { getToonMaterial } from '../../utils/Materials.js';
import { Colors } from '../../utils/Colors.js';
import { OFFICE_DESK } from './furnishing.js';
import { RoomFrame } from './rooms.js';
import { slotFor } from './RoomPlanner.js';
import { triageQueue } from '../../ui/attention.js';
import { registerExtension, type OfficeExtension, type World } from '../../extensions.js';
import type { ManagedAgent } from '../../agents/AgentManager.js';

/**
 * Two small monitors on the user's own desk (issue #161, SBE-35 updated): a mirror of the
 * personal Jira board (#145, opt-in, off without credentials) and a mirror of the triage
 * panel's waiting list (core, always available). Canvas textures, the same cheap pattern as
 * the Jira wall board (`plugins/jira/client.ts`) and the GitHub cards: a frame mesh plus one
 * textured face, never merged into the static batch (a dynamic texture redraws).
 *
 * The office room is always the first rented room (`room-0-office`, `rooms.ts`'s own naming;
 * the Jira wall board makes the same assumption for its slot). Without that room in the scene
 * yet, neither monitor mounts (rule 3, graceful degradation) — the same guard the Jira board
 * itself uses.
 */

const OFFICE_ROOM_NAME = 'room-0-office';
const MONITOR_WIDTH = 0.5;
const MONITOR_HEIGHT = 0.32;
const MONITOR_CANVAS = { width: 320, height: 200 };
const MAX_ROWS = 5;
/** A little in front of the seat, either side of the desk's own center monitor. */
const MONITOR_A_OFFSET = 0.6;
const MONITOR_D_OFFSET = 0.8;
const MONITOR_Y = 1.05;

function officeFrame(): RoomFrame {
  const slot = slotFor(0);
  return new RoomFrame(slot.rect, slot.door);
}

/** Each monitor's own `a` offset (left negative, right positive): the one list `buildMonitor` and `monitorWorldCorners` both walk, so neither can drift from the other. */
const MONITOR_A_OFFSETS = [-MONITOR_A_OFFSET, MONITOR_A_OFFSET] as const;

/** Where a monitor's own group sits and faces. Pure geometry, shared by the mesh builder below and `monitorWorldCorners`. */
function monitorPose(a: number): { position: THREE.Vector3; rotationY: number } {
  const frame = officeFrame();
  return { position: frame.point(a, OFFICE_DESK.d - MONITOR_D_OFFSET, MONITOR_Y), rotationY: frame.faceAway };
}

/**
 * The world-space corners of each monitor's face, left then right (issue #161 review, defect
 * 4): lets the label declutter keep a queued agent's label clear of them, in desk mode. Pure —
 * no scene, no mounted group needed: the office's own slot (ring 0, index 0) is a fixed
 * assumption the whole module already makes (the same one the Jira wall board makes for its
 * own slot), so this needs nothing from the live scene to compute.
 */
export function monitorWorldCorners(): THREE.Vector3[][] {
  return MONITOR_A_OFFSETS.map((a) => {
    const { position, rotationY } = monitorPose(a);
    const up = new THREE.Vector3(0, 1, 0);
    return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
      const local = new THREE.Vector3(sx * (MONITOR_WIDTH / 2), sy * (MONITOR_HEIGHT / 2), 0);
      local.applyAxisAngle(up, rotationY);
      return local.add(position);
    });
  });
}

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
  ctx.font = 'bold 20px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(title, 10, 8);
  if (rows.length === 0) {
    ctx.fillStyle = '#8ea0b2';
    ctx.font = '14px sans-serif';
    ctx.fillText(empty, 10, 40);
    return;
  }
  const top = 36;
  const rowHeight = 28;
  const shown = rows.slice(0, MAX_ROWS);
  shown.forEach((row, i) => {
    const y = top + i * rowHeight;
    ctx.fillStyle = i % 2 === 0 ? '#263340' : '#1d2733';
    ctx.fillRect(4, y, width - 8, rowHeight - 3);
    ctx.fillStyle = '#eef3f8';
    ctx.font = '14px sans-serif';
    ctx.fillText(fittedText(ctx, row, width - 20), 10, y + 6);
  });
  if (rows.length > shown.length) {
    ctx.fillStyle = '#8ea0b2';
    ctx.font = '12px sans-serif';
    ctx.fillText(`+${rows.length - shown.length} more`, 10, top + shown.length * rowHeight + 4);
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

  const bezelGeometry = new THREE.BoxGeometry(MONITOR_WIDTH + 0.04, MONITOR_HEIGHT + 0.04, 0.03);
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
