import * as THREE from 'three';
import type { ManagedAgent } from '../../src/agents/AgentManager.js';
import { canvas, fitted, textWidth } from './text.js';

/**
 * Issue cards worn like badges on the shoulders and upper arms. The hands stay
 * free for equipment and the head for persona hats.
 *
 * - Order: the newest issue goes on the shoulder nearest the camera, the next
 *   on the other shoulder, then the upper arms (near, far, near). Up to 5.
 * - Each card stays upright (world up) and turns only about the vertical axis
 *   toward the camera. The scene hook `onBeforeRender` receives the camera
 *   before the renderer uploads the geometry, so the cards face the camera of
 *   the frame that draws them.
 * - Every card of every agent is in one geometry with one texture atlas: all
 *   cards cost one draw call. Each card has a front and a back face with their
 *   own UVs, so no side shows mirrored text.
 * - Border: the issue label color (`rrggbb` from the projection), else neutral.
 */

export const MAX_CARDS_PER_AGENT = 5;
/** A front quad and a back quad. */
export const VERTICES_PER_CARD = 8;
export const CARD_NEUTRAL_BORDER = '#8a8f98';

/** The atlas holds at most 256 cells (8 x 32 cells of 256 x 128 = 2048 x 4096 pixels). */
const MAX_CARDS = 256;
const CELL = { width: 256, height: 128 };
const ATLAS_COLUMNS = 8;
const BORDER = 12;
/** One line only when it fits at 40 px or more; else the repository goes above a large `#N`. */
const FONT_SIZES = [48, 40];
const REPO_FONT_SIZES = [30, 24, 19, 15];
const HEX = /^[0-9a-f]{6}$/i;

const CARD_WIDTH = 0.2;
const CARD_HEIGHT = 0.1;
/** Card center distance from the shoulder joint, along the arm. */
const FIRST_ROW = 0.06;
/** Distance between two card centers on one side; along a raised arm the cards stack up, else down, never overlapping. */
const ROW_STEP = 0.11;
/** Away from the body, beyond the arm and clear of the hands when they type in front of the shoulders. */
const OUTWARD = 0.12;
/** Toward the camera, so the card sits in front of the arm. */
const LIFT = 0.06;
/** Half the distance between the front and the back face. */
const FACE_GAP = 0.002;
/** The cards change side only when the camera is clearly on the other side (share of the horizontal view direction). */
const SIDE_SWITCH = 0.25;

/** Newest first: near shoulder, far shoulder, near upper arm, far upper arm, near upper arm lower. */
const SLOTS: ReadonlyArray<{ near: boolean; row: number }> = [
  { near: true, row: 0 }, { near: false, row: 0 }, { near: true, row: 1 }, { near: false, row: 1 }, { near: true, row: 2 },
];

type Issue = NonNullable<NonNullable<ManagedAgent['info']['extras']>['issues']>[number];

export interface CardPlacement {
  agentId: string;
  number: number;
  /** Index in the slot order above. */
  slot: number;
}

interface Wearer {
  agent: ManagedAgent;
  first: number;
  count: number;
  nearRight: boolean;
}

function borderColor(color: string | undefined): string {
  return color && HEX.test(color) ? `#${color.toLowerCase()}` : CARD_NEUTRAL_BORDER;
}

/** `<repo>#N` on one line when it fits, else the repository above the number, else `#N` alone. */
function drawCell(ctx: CanvasRenderingContext2D, x: number, y: number, issue: Issue): void {
  const { width, height } = CELL;
  ctx.fillStyle = borderColor(issue.color);
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = '#fffdf6';
  ctx.fillRect(x + BORDER, y + BORDER, width - 2 * BORDER, height - 2 * BORDER);
  ctx.fillStyle = '#2b2b2b';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const room = width - 2 * BORDER - 12;
  const centerX = x + width / 2;
  const middle = y + height / 2;
  const { repo, number } = issue;
  const label = `${repo ?? ''}#${number}`;
  const size = FONT_SIZES.find((candidate) => {
    ctx.font = `bold ${candidate}px sans-serif`;
    return textWidth(ctx, label) <= room;
  });
  if (size !== undefined || !repo) {
    ctx.font = `bold ${size ?? FONT_SIZES[0]}px sans-serif`;
    ctx.fillText(fitted(ctx, size !== undefined ? label : `#${number}`, room), centerX, middle);
    return;
  }
  const repoSize = REPO_FONT_SIZES.find((candidate) => {
    ctx.font = `bold ${candidate}px sans-serif`;
    return textWidth(ctx, repo) <= room;
  }) ?? REPO_FONT_SIZES[REPO_FONT_SIZES.length - 1];
  ctx.font = `bold ${repoSize}px sans-serif`;
  ctx.fillText(fitted(ctx, repo, room), centerX, middle - 22);
  ctx.font = 'bold 44px sans-serif';
  ctx.fillText(fitted(ctx, `#${number}`, room), centerX, middle + 16);
}

function cellKey(issue: Issue): string {
  return `${issue.repo ?? ''}#${issue.number}|${issue.color ?? ''}`;
}

/** Shown when the figure and all its parents are visible and it is in a scene. */
function isShown(root: THREE.Object3D): boolean {
  let node: THREE.Object3D | null = root;
  for (; node; node = node.parent) {
    if (!node.visible) return false;
    if ((node as THREE.Scene).isScene) return true;
  }
  return false;
}

const armDown = new THREE.Vector3();

/** The arm points above the horizontal (a raised hand). */
function isRaised(arm: THREE.Object3D): boolean {
  return armDown.set(0, -1, 0).transformDirection(arm.matrixWorld).y > 0;
}

const cameraPosition = new THREE.Vector3();
const local = new THREE.Vector3();
const bodyX = new THREE.Vector3();
const anchor = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const center = new THREE.Vector3();
const corner = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class IssueCardBatch {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private wearers: Wearer[] = [];
  private cards: CardPlacement[] = [];
  private forwards: THREE.Vector3[] = [];
  private signature = '';

  constructor() {
    const material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = 'github-cards';
    this.mesh.visible = false;
    // The vertices are in world space and move every frame
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    // Cards must not catch the clicks that select an agent
    this.mesh.raycast = () => undefined;
  }

  /** Where each card of the geometry belongs, in geometry order. */
  get placements(): readonly CardPlacement[] {
    return this.cards;
  }

  /** Add the mesh and chain the scene hook that turns the cards to the camera of each render. */
  attach(scene: THREE.Scene): void {
    scene.add(this.mesh);
    const previous = scene.onBeforeRender;
    const cards = this;
    scene.onBeforeRender = function (this: THREE.Scene, ...args: Parameters<THREE.Scene['onBeforeRender']>) {
      previous.apply(this, args);
      cards.faceCamera(args[2]);
    };
  }

  /** Rebuild the cards when the issues change. Nothing happens when they are the same. */
  sync(agents: ManagedAgent[]): void {
    const worn = agents
      .map((agent) => ({ agent, issues: (agent.info.extras?.issues ?? []).slice(0, MAX_CARDS_PER_AGENT) }))
      .filter((entry) => entry.issues.length > 0);
    const signature = worn
      .map(({ agent, issues }) => `${agent.info.id}@${agent.figure.group.id}:${issues.map(cellKey).join(',')}`)
      .join(';');
    if (signature === this.signature) return;
    this.signature = signature;

    const previousSides = new Map(this.wearers.map((wearer) => [wearer.agent.info.id, wearer.nearRight]));
    const cells = new Map<string, number>();
    const cellIssues: Issue[] = [];
    const cellOfCard: number[] = [];
    this.wearers = [];
    this.cards = [];
    for (const { agent, issues } of worn) {
      const room = Math.min(issues.length, MAX_CARDS - this.cards.length);
      if (room <= 0) break;
      this.wearers.push({ agent, first: this.cards.length, count: room, nearRight: previousSides.get(agent.info.id) ?? true });
      issues.slice(0, room).forEach((issue, slot) => {
        const key = cellKey(issue);
        if (!cells.has(key)) {
          cells.set(key, cellIssues.length);
          cellIssues.push(issue);
        }
        cellOfCard.push(cells.get(key)!);
        this.cards.push({ agentId: agent.info.id, number: issue.number, slot });
      });
    }
    this.forwards = this.cards.map(() => new THREE.Vector3());
    this.rebuild(cellIssues, cellOfCard);
  }

  /** Place every card: on its shoulder or upper arm, upright, turned about the vertical axis to the camera. */
  faceCamera(camera: THREE.Camera): void {
    if (this.cards.length === 0) return;
    cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    const position = this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const array = position.array as Float32Array;
    for (const wearer of this.wearers) {
      const root = wearer.agent.figure.group;
      if (!isShown(root)) {
        array.fill(0, wearer.first * VERTICES_PER_CARD * 3, (wearer.first + wearer.count) * VERTICES_PER_CARD * 3);
        continue;
      }
      this.chooseSide(wearer, root);
      const { joints } = wearer.agent.figure;
      bodyX.set(1, 0, 0).transformDirection(root.matrixWorld);
      bodyX.y = 0;
      bodyX.normalize();
      const previous = { near: NaN, far: NaN };
      for (let k = 0; k < wearer.count; k++) {
        const slot = SLOTS[k];
        const onRight = slot.near === wearer.nearRight;
        const arm = onRight ? joints.rightUpperArm : joints.leftUpperArm;
        anchor.set(0, -(FIRST_ROW + slot.row * ROW_STEP), 0);
        arm.localToWorld(anchor);
        anchor.addScaledVector(bodyX, onRight ? OUTWARD : -OUTWARD);
        const side = slot.near ? 'near' : 'far';
        if (!Number.isNaN(previous[side])) {
          anchor.y = isRaised(arm)
            ? Math.max(anchor.y, previous[side] + ROW_STEP)
            : Math.min(anchor.y, previous[side] - ROW_STEP);
        }
        previous[side] = anchor.y;
        this.writeCard(array, wearer.first + k, root);
      }
    }
    position.needsUpdate = true;
  }

  /** The newest card goes to the side that faces the camera; a margin keeps it from flipping in front views. */
  private chooseSide(wearer: Wearer, root: THREE.Object3D): void {
    root.worldToLocal(local.copy(cameraPosition));
    const horizontal = Math.hypot(local.x, local.z);
    if (horizontal < 1e-6) return;
    const lateral = local.x / horizontal;
    if (lateral > SIDE_SWITCH) wearer.nearRight = true;
    else if (lateral < -SIDE_SWITCH) wearer.nearRight = false;
  }

  /** Card `index` around `anchor`: upright, its front toward the camera on the horizontal plane. */
  private writeCard(array: Float32Array, index: number, root: THREE.Object3D): void {
    const stored = this.forwards[index];
    forward.subVectors(cameraPosition, anchor);
    forward.y = 0;
    if (forward.lengthSq() > 1e-8) stored.copy(forward.normalize());
    else if (stored.lengthSq() === 0) stored.set(0, 0, 1).transformDirection(root.matrixWorld).setY(0).normalize();
    forward.copy(stored);
    right.set(forward.z, 0, -forward.x);
    center.copy(anchor).addScaledVector(forward, LIFT);
    const halfWidth = CARD_WIDTH / 2;
    const halfHeight = CARD_HEIGHT / 2;
    // Front: bottom-left, bottom-right, top-right, top-left. Back: the same corners seen from behind.
    const corners: Array<[number, number, number]> = [
      [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
      [1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1],
    ];
    corners.forEach(([x, y, face], k) => {
      corner.copy(center)
        .addScaledVector(right, x * halfWidth)
        .addScaledVector(UP, y * halfHeight)
        .addScaledVector(forward, face * FACE_GAP);
      corner.toArray(array, (index * VERTICES_PER_CARD + k) * 3);
    });
  }

  private rebuild(cellIssues: Issue[], cellOfCard: number[]): void {
    const old = this.mesh.material.map;
    this.mesh.geometry.dispose();
    old?.dispose();
    this.mesh.material.map = null;
    const count = this.cards.length;
    this.mesh.visible = count > 0;
    if (count === 0) {
      this.mesh.geometry = new THREE.BufferGeometry();
      return;
    }

    const rows = Math.ceil(cellIssues.length / ATLAS_COLUMNS);
    const atlasWidth = ATLAS_COLUMNS * CELL.width;
    const atlasHeight = rows * CELL.height;
    const atlas = canvas(atlasWidth, atlasHeight);
    const ctx = atlas.getContext('2d');
    if (ctx) {
      cellIssues.forEach((issue, cell) => {
        drawCell(ctx, (cell % ATLAS_COLUMNS) * CELL.width, Math.floor(cell / ATLAS_COLUMNS) * CELL.height, issue);
      });
    }
    const texture = new THREE.CanvasTexture(atlas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh.material.map = texture;
    this.mesh.material.needsUpdate = true;

    const uvs = new Float32Array(count * VERTICES_PER_CARD * 2);
    const indices: number[] = [];
    // Half a texel inside the cell, so a neighbor cell never bleeds in
    const insetU = 0.5 / atlasWidth;
    const insetV = 0.5 / atlasHeight;
    cellOfCard.forEach((cell, card) => {
      const u0 = ((cell % ATLAS_COLUMNS) * CELL.width) / atlasWidth + insetU;
      const u1 = ((cell % ATLAS_COLUMNS + 1) * CELL.width) / atlasWidth - insetU;
      const vTop = 1 - (Math.floor(cell / ATLAS_COLUMNS) * CELL.height) / atlasHeight - insetV;
      const vBottom = 1 - ((Math.floor(cell / ATLAS_COLUMNS) + 1) * CELL.height) / atlasHeight + insetV;
      const quad = [u0, vBottom, u1, vBottom, u1, vTop, u0, vTop];
      uvs.set(quad, card * VERTICES_PER_CARD * 2);
      uvs.set(quad, (card * VERTICES_PER_CARD + 4) * 2);
      const base = card * VERTICES_PER_CARD;
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      indices.push(base + 4, base + 5, base + 6, base + 4, base + 6, base + 7);
    });
    const geometry = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(new Float32Array(count * VERTICES_PER_CARD * 3), 3);
    positions.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', positions);
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    this.mesh.geometry = geometry;
  }
}
