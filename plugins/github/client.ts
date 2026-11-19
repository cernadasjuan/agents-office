import * as THREE from 'three';
import type { ManagedAgent } from '../../src/agents/AgentManager.js';
import { registerExtension, type OfficeExtension, type World, type WorldBoard } from '../../src/extensions.js';

/**
 * Browser part of the GitHub plugin: kanban boards on the walls and issue
 * cards in the agents' right hands. Every drawn text comes from the projected
 * API data and goes to a canvas through fillText.
 *
 * The cards hang from the hand but do not take its rotation: each frame
 * `update` turns them upright and to the agent's front, in world space.
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
const CARD_CANVAS = { width: 128, height: 176 };
const CARD_FONT_SIZES = [40, 32, 26, 22];
const REPO_FONT_SIZES = [22, 18, 15, 12];
/** Fan step between two cards, in radians. With 5 cards the outer ones tilt 0.2 rad (11.5 degrees). */
const CARD_FAN_STEP = 0.1;
/** Where the cards sit next to the hand, in the agent's frame: a little below and in front. */
const CARD_OFFSET = new THREE.Vector3(0, -0.03, 0.07);
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

/** `<repo>#N` on one line when it fits, else the repository above the number, else `#N` alone. */
function drawCard(target: HTMLCanvasElement, number: number, repo: string | undefined): void {
  const ctx = target.getContext('2d');
  if (!ctx) return;
  const { width, height } = target;
  const room = width - 12;
  ctx.fillStyle = '#fffdf6';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#3a6ea5';
  ctx.fillRect(0, 0, width, 22);
  ctx.fillStyle = '#2b2b2b';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const middle = height / 2 + 10;
  const label = `${repo ?? ''}#${number}`;
  const size = CARD_FONT_SIZES.find((candidate) => {
    ctx.font = `bold ${candidate}px sans-serif`;
    return textWidth(ctx, label) <= room;
  });
  if (size !== undefined || !repo) {
    ctx.font = `bold ${size ?? CARD_FONT_SIZES[0]}px sans-serif`;
    ctx.fillText(fitted(ctx, size !== undefined ? label : `#${number}`, room), width / 2, middle);
    return;
  }
  const repoSize = REPO_FONT_SIZES.find((candidate) => {
    ctx.font = `bold ${candidate}px sans-serif`;
    return textWidth(ctx, repo) <= room;
  }) ?? REPO_FONT_SIZES[REPO_FONT_SIZES.length - 1];
  ctx.font = `bold ${repoSize}px sans-serif`;
  ctx.fillText(fitted(ctx, repo, room), width / 2, middle - 26);
  ctx.font = 'bold 40px sans-serif';
  ctx.fillText(fitted(ctx, `#${number}`, room), width / 2, middle + 18);
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
  figure: ManagedAgent['figure'];
  disposables: Array<{ dispose(): void }>;
  signature: string;
}

type HeldIssue = NonNullable<NonNullable<ManagedAgent['info']['extras']>['issues']>[number];

const handRotation = new THREE.Quaternion();
const bodyRotation = new THREE.Quaternion();
const handInverse = new THREE.Quaternion();
const worldOffset = new THREE.Vector3();

/**
 * Cancel the hand rotation: give the card group the body rotation (a turn
 * about the vertical axis only) in world space, and place it next to the hand
 * in the body frame.
 */
function holdUpright(cards: HeldCards): void {
  const hand = cards.group.parent;
  if (!hand) return;
  hand.updateWorldMatrix(true, false);
  hand.getWorldQuaternion(handRotation);
  cards.figure.group.getWorldQuaternion(bodyRotation);
  handInverse.copy(handRotation).invert();
  cards.group.quaternion.copy(handInverse).multiply(bodyRotation);
  worldOffset.copy(CARD_OFFSET).applyQuaternion(bodyRotation).applyQuaternion(handInverse);
  cards.group.position.copy(worldOffset);
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

  /** Runs after the figures animate: keeps every held card upright, whatever the arm does. */
  update(): void {
    for (const cards of this.held.values()) holdUpright(cards);
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
      const issues = (agent.info.extras?.issues ?? []).slice(0, MAX_HELD_CARDS);
      const signature = issues.map((issue) => `${issue.repo ?? ''}#${issue.number}`).join(',');
      const current = this.held.get(agent.info.id);
      if ((current?.signature ?? '') === signature) continue;
      if (current) this.drop(agent.info.id, current);
      if (issues.length > 0) this.hold(agent, issues, signature);
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

  private hold(agent: ManagedAgent, issues: HeldIssue[], signature: string): void {
    const group = new THREE.Group();
    group.name = 'github-cards';
    const geometry = new THREE.PlaneGeometry(0.1, 0.14);
    const disposables: Array<{ dispose(): void }> = [geometry];
    issues.forEach((issue, index) => {
      const surface = canvas(CARD_CANVAS.width, CARD_CANVAS.height);
      drawCard(surface, issue.number, issue.repo);
      const texture = new THREE.CanvasTexture(surface);
      texture.colorSpace = THREE.SRGBColorSpace;
      // One face per side, so the text never shows mirrored.
      const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.FrontSide });
      const card = new THREE.Mesh(geometry, material);
      const back = new THREE.Mesh(geometry, material);
      back.name = 'github-card-back';
      back.rotation.y = Math.PI;
      back.position.z = -0.001;
      card.add(back);
      const offset = index - (issues.length - 1) / 2;
      // The most recent issue (first) lies on top of the fan.
      card.position.set(offset * 0.025, 0, (issues.length - 1 - index) * 0.003);
      card.rotation.z = -offset * CARD_FAN_STEP;
      group.add(card);
      disposables.push(texture, material);
    });
    agent.figure.joints.rightHand.add(group);
    const held: HeldCards = { group, figure: agent.figure, disposables, signature };
    holdUpright(held);
    this.held.set(agent.info.id, held);
  }

  private drop(id: string, cards: HeldCards): void {
    cards.group.removeFromParent();
    disposeAll(cards.disposables);
    this.held.delete(id);
  }
}

registerExtension(new GithubOfficeExtension());
