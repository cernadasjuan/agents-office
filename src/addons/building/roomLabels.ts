import * as THREE from 'three';
import { ROOM_SIZE, type Rect } from './RoomPlanner.js';

/** First person: a small plate high in the room; its top (2.55) stays below the wall top, so walls hide it. */
export const FIRST_PERSON_LABEL_Y = 2.2;
export const FIRST_PERSON_LABEL_HEIGHT = 0.7;
/** Overview: plate height at the reference zoom distance; it grows with the distance beyond it. */
export const OVERVIEW_LABEL_HEIGHT = 1.6;
export const OVERVIEW_LABEL_REFERENCE_ZOOM = 40;
/** Overview: the plate bottom, above the lowered walls and the door frames. */
export const OVERVIEW_LABEL_BOTTOM = 1.3;
/** A plate is never wider than this, so labels of two neighbor rooms do not overlap. */
export const ROOM_LABEL_MAX_WIDTH = ROOM_SIZE - 1;
/** Overview: a plate is never taller than this, so labels of two rooms in a column do not overlap. */
export const OVERVIEW_LABEL_MAX_HEIGHT = 5;
/** Characters per line: the full face, and the compact face of the default overview. */
export const FULL_LABEL_CHARS = 16;
export const COMPACT_LABEL_CHARS = 7;
/** Most room labels a scene draws (one instance each). */
export const MAX_ROOM_LABELS = 128;
const LABEL_FONT_PX = 64;
const LABEL_LINE_PX = 68;
const LABEL_PAD_X = 8;
const LABEL_PAD_Y = 6;
/** Capitals are drawn condensed (narrower), so a name fits a room width at a readable height. */
const LABEL_CONDENSE = 0.58;
const FONT = `800 ${LABEL_FONT_PX}px system-ui, 'Helvetica Neue', Arial, sans-serif`;
/** Atlas slot size in pixels, and the gap that keeps mipmaps of two slots apart. */
const SLOT_WIDTH = 384;
const SLOT_HEIGHT = 176;
const SLOT_GAP = 4;
const ATLAS_COLUMNS = 8;
const ATLAS_START_ROWS = 4;

/**
 * Cuts a single too-long word or line in the middle ("AGENT-…VIEW"), not at the
 * front. Two names that share a long prefix still differ after the cut, since
 * the tail survives too (issue #87, AC3: cutting only the front made compact
 * chips that share their first characters collide). The ellipsis always costs
 * one character of the budget; the rest splits as evenly as possible, the head
 * getting the extra character on an odd budget. Splits on code points
 * (`Array.from`), not UTF-16 units, so a surrogate pair (an emoji) never cuts in half.
 */
export function middleEllipsis(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  if (maxChars <= 1) return '…';
  const keep = maxChars - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return tail > 0 ? `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}` : `${chars.slice(0, head).join('')}…`;
}

/**
 * Up to `maxLines` lines of at most `maxChars`, cut at word breaks, with an ellipsis
 * when the text is longer. A " · " starts a new line ("DESKS" / "WS10"). A single
 * word too long for one line cuts in the middle, not the front (`middleEllipsis`).
 */
export function roomLabelLines(text: string, maxChars: number, maxLines = 2): string[] {
  const cut = (part: string) => middleEllipsis(part, maxChars);
  const lines: string[] = [];
  for (const part of text.trim().split(/\s+·\s+/)) {
    let first = true;
    for (const word of part.split(/\s+/).filter(Boolean)) {
      const last = lines[lines.length - 1];
      if (!first && last !== undefined && `${last} ${word}`.length <= maxChars) lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
      first = false;
    }
  }
  if (lines.length <= maxLines) return lines.map(cut);
  // More lines: the last kept line ends with an ellipsis after a whole word when it fits
  const last = lines[maxLines - 1];
  return [...lines.slice(0, maxLines - 1).map(cut), last.length <= maxChars ? `${last}…` : cut(last)];
}

/**
 * The compact face of the default overview: two short lines. A longer name keeps
 * its first line and its last word ("MISSION" / "…3"), so rooms with a shared
 * first word stay apart. The last word itself cuts in the middle when it does
 * not fit (`middleEllipsis`), so two names whose last words share a prefix
 * ("…PERSI…" for both "…PERSISTENCE" and "…PERSONA" before this fix) still
 * differ (issue #87, AC3).
 */
export function compactLabelLines(text: string): string[] {
  const lines = roomLabelLines(text, COMPACT_LABEL_CHARS, 99);
  if (lines.length <= 2) return lines;
  const words = text.trim().split(/\s+/);
  const lastWord = words[words.length - 1];
  return [lines[0], `…${middleEllipsis(lastWord, COMPACT_LABEL_CHARS - 1)}`];
}

/** What the label controller tells a room label each refresh. */
export interface RoomLabelView {
  /** First person, or a view from above (the overview, the isometric view). */
  viewMode: 'overview' | 'first-person' | 'isometric';
  zoomDistance: number;
  /** Zoomed in, pointed at or labels: all: the full name. */
  detail: boolean;
}

interface LabelFace {
  key: string;
  lines: string[];
  /** Size in pixels at the label font; aspect = width / height. */
  width: number;
  height: number;
}

let measureContext: CanvasRenderingContext2D | null | undefined;

function measureFace(key: string, lines: string[]): LabelFace {
  if (measureContext === undefined) measureContext = document.createElement('canvas').getContext('2d');
  const ctx = measureContext;
  if (ctx) {
    ctx.font = FONT;
    ctx.letterSpacing = '2px';
  }
  const longest = Math.max(...lines.map((line) => line.length), 1);
  const measured = ctx?.measureText ? Math.max(...lines.map((line) => ctx.measureText(line)?.width ?? 0)) : 0;
  const textWidth = Number.isFinite(measured) && measured > 0 ? measured : longest * LABEL_FONT_PX * 0.75;
  return { key, lines, width: Math.ceil(textWidth * LABEL_CONDENSE + LABEL_PAD_X * 2), height: lines.length * LABEL_LINE_PX + LABEL_PAD_Y * 2 };
}

/**
 * Where and how big a room label is. First person: a small plate high in the
 * room, below the wall top, hidden by walls (depth test). Overview: a plate that
 * grows with the zoom distance, so it keeps its size on screen, but never wider
 * than a room, so two room labels do not overlap; it draws on top.
 */
export function roomLabelPose(view: RoomLabelView, aspect: number): { height: number; width: number; y: number; onTop: boolean } {
  if (view.viewMode === 'first-person') {
    const height = Math.min(FIRST_PERSON_LABEL_HEIGHT, ROOM_LABEL_MAX_WIDTH / aspect);
    return { height, width: height * aspect, y: FIRST_PERSON_LABEL_Y, onTop: false };
  }
  const wanted = OVERVIEW_LABEL_HEIGHT * Math.max(1, view.zoomDistance / OVERVIEW_LABEL_REFERENCE_ZOOM);
  const height = Math.min(wanted, OVERVIEW_LABEL_MAX_HEIGHT, ROOM_LABEL_MAX_WIDTH / aspect);
  return { height, width: height * aspect, y: OVERVIEW_LABEL_BOTTOM + height / 2, onTop: true };
}

function sceneOf(object: THREE.Object3D): THREE.Scene | null {
  let node: THREE.Object3D | null = object;
  while (node.parent) node = node.parent;
  return (node as THREE.Scene).isScene ? (node as THREE.Scene) : null;
}

function shownInTree(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}

/**
 * A room name in the world. The label is a handle (an empty object above the
 * room center, `name = 'room-label'`): its position and scale are the plate
 * pose, and the scene's `RoomLabelBatch` draws every plate in one call. It has a
 * full face (first person, zoomed in, pointed at) and a compact face (the default
 * overview). The label controller calls `userData.applyView` each refresh; until
 * then it keeps the first person pose.
 */
export function roomLabel(text: string, position: THREE.Vector3, rect: Rect): THREE.Object3D {
  const label = new THREE.Object3D();
  label.name = 'room-label';
  label.position.set(position.x, FIRST_PERSON_LABEL_Y, position.z);
  // The label controller hides it in first person while the camera is inside this room
  label.userData.roomRect = { ...rect };
  let view: RoomLabelView = { viewMode: 'first-person', zoomDistance: 0, detail: true };
  label.userData.applyView = (next: RoomLabelView) => {
    view = next;
    const faces = label.userData.faces as { full: LabelFace; compact: LabelFace };
    const face = next.viewMode !== 'first-person' && !next.detail ? faces.compact : faces.full;
    label.userData.face = face;
    label.userData.labelLines = face.lines;
    const pose = roomLabelPose(next, face.width / face.height);
    label.scale.set(pose.width, pose.height, 1);
    label.position.y = pose.y;
    label.userData.onTop = pose.onTop;
    const scene = sceneOf(label);
    if (scene) roomLabelBatchFor(scene).track(label);
  };
  label.userData.refreshView = () => (label.userData.applyView as (v: RoomLabelView) => void)(view);
  setRoomLabelText(label, text);
  return label;
}

/** Set the label text: both faces are measured again, the batch redraws the plate. */
export function setRoomLabelText(label: THREE.Object3D, text: string): void {
  if (label.userData.roomLabel === text) return;
  label.userData.roomLabel = text;
  const upper = text.toUpperCase();
  const orBlank = (lines: string[]) => (lines.length > 0 ? lines : ['']);
  label.userData.faces = {
    full: measureFace(`full:${upper}`, orBlank(roomLabelLines(upper, FULL_LABEL_CHARS))),
    compact: measureFace(`compact:${upper}`, orBlank(compactLabelLines(upper))),
  };
  (label.userData.refreshView as () => void)();
}

const VERTEX = /* glsl */ `
attribute vec4 uvRect;
varying vec2 vUv;
void main() {
  // A billboard like a sprite: the instance matrix holds the center and the plate size
  vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 size = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
  center.xy += position.xy * size;
  gl_Position = projectionMatrix * center;
  vUv = uvRect.xy + uv * uvRect.zw;
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D atlas;
varying vec2 vUv;
void main() {
  vec4 color = texture2D(atlas, vUv);
  if (color.a < 0.02) discard;
  gl_FragColor = color;
  #include <colorspace_fragment>
}`;

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Every room label plate of a scene in one draw call: an instanced billboard quad
 * and one canvas atlas with a slot per label. Each frame (`onBeforeRender`) it
 * copies the label handles' poses into the instances; a hidden or detached label
 * gets scale 0. A slot is drawn again only when the label face changes.
 */
export class RoomLabelBatch {
  readonly mesh: THREE.InstancedMesh;
  private handles: THREE.Object3D[] = [];
  private drawnFaces: string[] = [];
  private canvas: HTMLCanvasElement;
  private texture: THREE.CanvasTexture;
  private material: THREE.ShaderMaterial;
  private uvRects: THREE.InstancedBufferAttribute;
  private rows = ATLAS_START_ROWS;

  constructor(private scene: THREE.Scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SLOT_WIDTH * ATLAS_COLUMNS;
    this.canvas.height = SLOT_HEIGHT * this.rows;
    this.texture = this.newTexture();
    this.material = new THREE.ShaderMaterial({
      uniforms: { atlas: { value: this.texture } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
    });
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.uvRects = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ROOM_LABELS * 4), 4);
    geometry.setAttribute('uvRect', this.uvRects);
    this.mesh = new THREE.InstancedMesh(geometry, this.material, MAX_ROOM_LABELS);
    this.mesh.name = 'room-label-batch';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.userData.dynamic = true;
    this.mesh.raycast = () => undefined;
    this.mesh.onBeforeRender = () => this.sync();
    scene.add(this.mesh);
  }

  /** The label handles this batch draws, in instance order. */
  get labels(): readonly THREE.Object3D[] {
    return this.handles;
  }

  /** Draw this label (idempotent). */
  track(label: THREE.Object3D): void {
    if (this.handles.includes(label) || this.handles.length >= MAX_ROOM_LABELS) return;
    this.handles.push(label);
    this.drawnFaces.push('');
    this.mesh.count = this.handles.length;
  }

  /** Draw every label under a root (a room just added to the scene). */
  collect(root: THREE.Object3D): void {
    root.traverse((object) => {
      if (object.userData.roomRect && object.userData.faces) this.track(object);
    });
  }

  /** Copy each label pose into its instance, redraw changed faces. Runs before each render. */
  sync(): void {
    let onTop = false;
    let uvChanged = false;
    for (let i = 0; i < this.handles.length; i++) {
      const label = this.handles[i];
      const shown = sceneOf(label) === this.scene && shownInTree(label);
      if (!shown) {
        this.mesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      onTop ||= label.userData.onTop === true;
      const face = label.userData.face as LabelFace | undefined ?? (label.userData.faces as { full: LabelFace }).full;
      if (this.drawnFaces[i] !== face.key) {
        this.drawSlot(i, face);
        this.drawnFaces[i] = face.key;
        uvChanged = true;
      }
      label.updateWorldMatrix(true, false);
      this.mesh.setMatrixAt(i, label.matrixWorld);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (uvChanged) this.uvRects.needsUpdate = true;
    this.material.depthTest = !onTop;
  }

  private newTexture(): THREE.CanvasTexture {
    const texture = new THREE.CanvasTexture(this.canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private drawSlot(index: number, face: LabelFace): void {
    if (index >= ATLAS_COLUMNS * this.rows) this.growAtlas();
    const column = index % ATLAS_COLUMNS;
    const row = Math.floor(index / ATLAS_COLUMNS);
    const scale = Math.min((SLOT_WIDTH - SLOT_GAP * 2) / face.width, (SLOT_HEIGHT - SLOT_GAP * 2) / face.height);
    const width = face.width * scale;
    const height = face.height * scale;
    const x = column * SLOT_WIDTH + SLOT_GAP;
    const y = row * SLOT_HEIGHT + SLOT_GAP;
    const ctx = this.canvas.getContext('2d');
    if (ctx?.fillRect) {
      ctx.save();
      ctx.clearRect(column * SLOT_WIDTH, row * SLOT_HEIGHT, SLOT_WIDTH, SLOT_HEIGHT);
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.fillStyle = 'rgba(247, 241, 228, 0.92)';
      ctx.fillRect(0, 0, face.width, face.height);
      ctx.strokeStyle = 'rgba(42, 42, 62, 0.85)';
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, face.width - 4, face.height - 4);
      ctx.fillStyle = '#2a2a3e';
      ctx.font = FONT;
      ctx.letterSpacing = '2px';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.scale(LABEL_CONDENSE, 1);
      face.lines.forEach((line, i) => ctx.fillText(line, face.width / 2 / LABEL_CONDENSE, LABEL_PAD_Y + LABEL_LINE_PX * (i + 0.5)));
      ctx.restore();
    }
    // The canvas flips on upload: canvas row 0 is the top of the texture (v = 1)
    const W = this.canvas.width;
    const H = this.canvas.height;
    this.uvRects.setXYZW(index, x / W, 1 - (y + height) / H, width / W, height / H);
    this.texture.needsUpdate = true;
  }

  /** More labels than slots: a taller atlas; every slot is drawn again. */
  private growAtlas(): void {
    this.rows *= 2;
    this.canvas.height = SLOT_HEIGHT * this.rows;
    this.texture.dispose();
    this.texture = this.newTexture();
    this.material.uniforms.atlas.value = this.texture;
    this.drawnFaces = this.drawnFaces.map(() => '');
    for (let i = 0; i < this.handles.length; i++) {
      const face = this.handles[i].userData.face as LabelFace | undefined ?? (this.handles[i].userData.faces as { full: LabelFace }).full;
      if (i < ATLAS_COLUMNS * this.rows) {
        this.drawSlot(i, face);
        this.drawnFaces[i] = face.key;
      }
    }
  }
}

/** The scene's room label batch, made on first use. */
export function roomLabelBatchFor(scene: THREE.Scene): RoomLabelBatch {
  const existing = scene.userData.roomLabelBatch as RoomLabelBatch | undefined;
  if (existing) return existing;
  const batch = new RoomLabelBatch(scene);
  scene.userData.roomLabelBatch = batch;
  return batch;
}
