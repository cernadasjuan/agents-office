import * as THREE from 'three';
import type { ManagedAgent } from '../../src/agents/AgentManager.js';
import { registerExtension, type OfficeExtension, type World, type WorldBoard } from '../../src/extensions.js';

/**
 * Browser part of the GitHub plugin: kanban boards on the walls and issue
 * cards in the agents' right hands. Every drawn text comes from the projected
 * API data and goes to a canvas through fillText.
 */

/** Wall spots for up to 4 boards. The first is the right part of the back wall, between the whiteboard at x=5 and the wall art at x=9. */
export const KANBAN_BOARD_SLOTS: Array<{ position: [number, number, number]; rotationY: number }> = [
  { position: [7.4, 3.5, -12.88], rotationY: 0 },
  { position: [14.88, 3.4, -9.5], rotationY: -Math.PI / 2 },
  { position: [14.88, 3.4, -6.4], rotationY: -Math.PI / 2 },
  { position: [-7.4, 3.5, -12.88], rotationY: 0 },
];

const BOARD_WIDTH = 2.4;
const BOARD_HEIGHT = 1.6;
const BOARD_CANVAS = { width: 960, height: 640 };
const CARD_CANVAS = { width: 64, height: 88 };
const MAX_HELD_CARDS = 5;

type Context = CanvasRenderingContext2D;

function canvas(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

function textWidth(ctx: Context, text: string): number {
  const width = ctx.measureText?.(text)?.width;
  return typeof width === 'number' ? width : text.length * 10;
}

function fitted(ctx: Context, text: string, maxWidth: number): string {
  if (textWidth(ctx, text) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && textWidth(ctx, `${cut}…`) > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function drawBoard(target: HTMLCanvasElement, board: WorldBoard): void {
  const ctx = target.getContext('2d');
  if (!ctx) return;
  const { width, height } = target;
  ctx.fillStyle = '#f7f4ec';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#2b2b2b';
  ctx.font = 'bold 34px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(fitted(ctx, board.title, width - 40), 20, 14);

  const columns = board.columns.slice(0, 6);
  if (columns.length === 0) return;
  const top = 64;
  const gap = 12;
  const columnWidth = (width - gap * (columns.length + 1)) / columns.length;
  const cardHeight = 40;
  columns.forEach((column, index) => {
    const x = gap + index * (columnWidth + gap);
    ctx.fillStyle = '#e4dfd2';
    ctx.fillRect(x, top, columnWidth, height - top - gap);
    ctx.fillStyle = '#2b2b2b';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(fitted(ctx, `${column.name} (${column.cards.length})`, columnWidth - 16), x + 8, top + 8);
    const room = Math.floor((height - top - 50 - gap) / (cardHeight + 6));
    const shown = column.cards.length > room ? column.cards.slice(0, room - 1) : column.cards;
    ctx.font = '20px sans-serif';
    shown.forEach((card, row) => {
      const y = top + 46 + row * (cardHeight + 6);
      ctx.fillStyle = '#fffdf6';
      ctx.fillRect(x + 6, y, columnWidth - 12, cardHeight);
      ctx.fillStyle = '#2b2b2b';
      ctx.fillText(fitted(ctx, `#${card.number} ${card.title}`.trim(), columnWidth - 28), x + 14, y + 10);
    });
    if (shown.length < column.cards.length) {
      ctx.fillStyle = '#6b6b6b';
      ctx.fillText(`+${column.cards.length - shown.length} more`, x + 14, top + 56 + shown.length * (cardHeight + 6));
    }
  });
}

function drawCard(target: HTMLCanvasElement, number: number): void {
  const ctx = target.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#fffdf6';
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.fillStyle = '#3a6ea5';
  ctx.fillRect(0, 0, target.width, 12);
  ctx.fillStyle = '#2b2b2b';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(fitted(ctx, `#${number}`, target.width - 6), target.width / 2, target.height / 2 + 6);
}

interface MountedBoard {
  group: THREE.Group;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  disposables: Array<{ dispose(): void }>;
  signature: string;
}

interface HeldCards {
  group: THREE.Group;
  disposables: Array<{ dispose(): void }>;
  signature: string;
}

function disposeAll(items: Array<{ dispose(): void }>): void {
  for (const item of items) item.dispose();
}

export class GithubOfficeExtension implements OfficeExtension {
  readonly id = 'github-kanban';
  readonly plugin = 'github';
  private scene: THREE.Scene | null = null;
  private boards: MountedBoard[] = [];
  private held = new Map<string, HeldCards>();

  start(scene: THREE.Scene): void {
    this.scene = scene;
  }

  worldChanged(world: World): void {
    if (!this.scene) return;
    const boards = (world.boards ?? []).slice(0, KANBAN_BOARD_SLOTS.length);
    while (this.boards.length > boards.length) this.unmountBoard(this.boards.pop()!);
    boards.forEach((board, index) => {
      const signature = JSON.stringify(board);
      const mounted = this.boards[index] ?? this.mountBoard(index);
      if (mounted.signature === signature) return;
      drawBoard(mounted.canvas, board);
      mounted.texture.needsUpdate = true;
      mounted.signature = signature;
    });
  }

  agentsChanged(agents: ManagedAgent[]): void {
    const present = new Set(agents.map((agent) => agent.info.id));
    for (const [id, cards] of this.held) {
      if (!present.has(id)) this.drop(id, cards);
    }
    for (const agent of agents) {
      const numbers = (agent.info.extras?.issues ?? []).slice(0, MAX_HELD_CARDS).map((issue) => issue.number);
      const signature = numbers.join(',');
      const current = this.held.get(agent.info.id);
      if ((current?.signature ?? '') === signature) continue;
      if (current) this.drop(agent.info.id, current);
      if (numbers.length > 0) this.hold(agent, numbers, signature);
    }
  }

  private mountBoard(index: number): MountedBoard {
    const slot = KANBAN_BOARD_SLOTS[index];
    const group = new THREE.Group();
    group.name = 'github-kanban';
    group.position.set(...slot.position);
    group.rotation.y = slot.rotationY;

    const frameGeometry = new THREE.BoxGeometry(BOARD_WIDTH + 0.12, BOARD_HEIGHT + 0.12, 0.05);
    const frameMaterial = new THREE.MeshLambertMaterial({ color: 0x6b4f35 });
    group.add(new THREE.Mesh(frameGeometry, frameMaterial));

    const surface = canvas(BOARD_CANVAS.width, BOARD_CANVAS.height);
    const texture = new THREE.CanvasTexture(surface);
    texture.colorSpace = THREE.SRGBColorSpace;
    const faceGeometry = new THREE.PlaneGeometry(BOARD_WIDTH, BOARD_HEIGHT);
    const faceMaterial = new THREE.MeshBasicMaterial({ map: texture });
    const face = new THREE.Mesh(faceGeometry, faceMaterial);
    face.position.z = 0.03;
    group.add(face);

    this.scene!.add(group);
    const mounted: MountedBoard = { group, texture, canvas: surface, signature: '',
      disposables: [frameGeometry, frameMaterial, faceGeometry, faceMaterial, texture] };
    this.boards[index] = mounted;
    return mounted;
  }

  private unmountBoard(board: MountedBoard): void {
    board.group.removeFromParent();
    disposeAll(board.disposables);
  }

  private hold(agent: ManagedAgent, numbers: number[], signature: string): void {
    const group = new THREE.Group();
    group.name = 'github-cards';
    group.position.set(0, -0.05, 0.05);
    const geometry = new THREE.PlaneGeometry(0.1, 0.14);
    const disposables: Array<{ dispose(): void }> = [geometry];
    numbers.forEach((number, index) => {
      const surface = canvas(CARD_CANVAS.width, CARD_CANVAS.height);
      drawCard(surface, number);
      const texture = new THREE.CanvasTexture(surface);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
      const card = new THREE.Mesh(geometry, material);
      const offset = index - (numbers.length - 1) / 2;
      card.position.set(offset * 0.025, 0, index * 0.003);
      card.rotation.z = -offset * 0.28;
      group.add(card);
      disposables.push(texture, material);
    });
    agent.figure.joints.rightHand.add(group);
    this.held.set(agent.info.id, { group, disposables, signature });
  }

  private drop(id: string, cards: HeldCards): void {
    cards.group.removeFromParent();
    disposeAll(cards.disposables);
    this.held.delete(id);
  }
}

registerExtension(new GithubOfficeExtension());
