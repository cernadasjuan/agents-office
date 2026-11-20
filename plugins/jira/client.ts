import * as THREE from 'three';
import { registerExtension, type OfficeExtension, type World, type WorldJiraTicket } from '../../src/extensions.js';

/**
 * Browser part of the Jira plugin (issue #145): one wall board in the CEO
 * office listing the tickets from `/api/world`. Plain canvas text, like the
 * GitHub kanban boards; not a clickable list (see the pull request notes). No
 * board shows while `world.jiraTickets` is empty (disabled, no credentials,
 * or an empty sprint) or the office room is not in the scene.
 */

const BOARD_WIDTH = 1.6;
const BOARD_HEIGHT = 1.2;
const BOARD_CANVAS = { width: 640, height: 480 };
const MAX_ROWS = 10;
const OFFICE_ROOM_NAME = 'room-0-office';

/**
 * The office's left side wall, between the small wall art at local depth 6 and
 * the corner plant and lamp past depth 11 (`src/addons/building/furnishing.ts`).
 * Computed once from the office's own slot (`RoomPlanner.ts` ring 0, index 0:
 * `rect: {minX:15,maxX:27,minZ:-6,maxZ:6}`, `door: {side:'west',at:0}`) through
 * the same `RoomFrame.point(a, d, y)` math `rooms.ts` uses, so it needs no
 * runtime import of the building layout: `point(-5.88, 9.3, 1.9)` = `(24.7, 1.9, -5.88)`,
 * facing into the room at `rotationY = 0`.
 */
const OFFICE_BOARD_SLOT = { position: [24.7, 1.9, -5.88] as const, rotationY: 0 };

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

export function drawJiraBoard(target: HTMLCanvasElement, tickets: WorldJiraTicket[]): void {
  const ctx = target.getContext('2d');
  if (!ctx) return;
  const { width, height } = target;
  ctx.fillStyle = '#f7f4ec';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#2b2b2b';
  ctx.font = 'bold 28px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText('My sprint', 16, 12);

  const top = 56;
  const rowHeight = 38;
  const shown = tickets.slice(0, MAX_ROWS);
  shown.forEach((ticket, row) => {
    const y = top + row * rowHeight;
    ctx.fillStyle = row % 2 === 0 ? '#efe9da' : '#f7f4ec';
    ctx.fillRect(8, y, width - 16, rowHeight - 4);
    ctx.fillStyle = '#2b2b2b';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(ticket.key, 16, y + 8);
    ctx.font = '18px sans-serif';
    const line = [ticket.summary, `(${ticket.status})`, ticket.priority ? `· ${ticket.priority}` : '']
      .filter((part) => part.length > 0).join(' ');
    ctx.fillText(fittedText(ctx, line, width - 140), 140, y + 8);
  });
  if (tickets.length > shown.length) {
    ctx.fillStyle = '#6b6b6b';
    ctx.font = '16px sans-serif';
    ctx.fillText(`+${tickets.length - shown.length} more`, 16, top + shown.length * rowHeight + 6);
  }
}

interface MountedBoard {
  group: THREE.Group;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  disposables: Array<{ dispose(): void }>;
  signature: string;
}

function disposeAll(items: Array<{ dispose(): void }>): void {
  for (const item of items) item.dispose();
}

export class JiraOfficeExtension implements OfficeExtension {
  readonly id = 'jira-board';
  readonly plugin = 'jira';
  private scene: THREE.Scene | null = null;
  private board: MountedBoard | null = null;

  start(scene: THREE.Scene): void {
    this.scene = scene;
  }

  worldChanged(world: World): void {
    if (!this.scene) return;
    const tickets = world.jiraTickets ?? [];
    // No data, or the building layout (and so the office room) is not active: no board (rule 3, graceful degradation).
    if (tickets.length === 0 || !this.scene.getObjectByName(OFFICE_ROOM_NAME)) {
      if (this.board) this.unmount();
      return;
    }
    if (!this.board) this.mount();
    const signature = JSON.stringify(tickets);
    if (this.board!.signature === signature) return;
    drawJiraBoard(this.board!.canvas, tickets);
    this.board!.texture.needsUpdate = true;
    this.board!.signature = signature;
  }

  private mount(): void {
    const group = new THREE.Group();
    group.name = 'jira-board';
    group.position.set(...OFFICE_BOARD_SLOT.position);
    group.rotation.y = OFFICE_BOARD_SLOT.rotationY;

    const frameGeometry = new THREE.BoxGeometry(BOARD_WIDTH + 0.1, BOARD_HEIGHT + 0.1, 0.05);
    const frameMaterial = new THREE.MeshLambertMaterial({ color: 0x4a5a6b });
    group.add(new THREE.Mesh(frameGeometry, frameMaterial));

    const surface = canvasEl(BOARD_CANVAS.width, BOARD_CANVAS.height);
    const texture = new THREE.CanvasTexture(surface);
    texture.colorSpace = THREE.SRGBColorSpace;
    const faceGeometry = new THREE.PlaneGeometry(BOARD_WIDTH, BOARD_HEIGHT);
    const faceMaterial = new THREE.MeshBasicMaterial({ map: texture });
    const face = new THREE.Mesh(faceGeometry, faceMaterial);
    face.position.z = 0.03;
    group.add(face);

    this.scene!.add(group);
    this.board = { group, texture, canvas: surface, signature: '',
      disposables: [frameGeometry, frameMaterial, faceGeometry, faceMaterial, texture] };
  }

  private unmount(): void {
    if (!this.board) return;
    this.board.group.removeFromParent();
    disposeAll(this.board.disposables);
    this.board = null;
  }
}

registerExtension(new JiraOfficeExtension());
