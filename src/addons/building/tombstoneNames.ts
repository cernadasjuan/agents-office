import * as THREE from 'three';

/**
 * Tombstone engraving (issue #159, review round 1): a texture decal flush on the
 * tombstone's own face, not a floating `CSS2DObject`. One small canvas atlas and
 * one instanced quad draw every engraved name of the whole scene in a single call
 * (same pattern as `roomLabels.ts`'s `RoomLabelBatch`), so the 12-tombstone cap
 * per war room never grows the draw-call budget past this one call. Unlike a room
 * label, the quad is NOT a billboard: its vertex shader applies the full instance
 * matrix (translation, rotation and scale), so it inherits its handle's own
 * orientation — a handle parented to the tombstone's own object reads as carved
 * into the stone, facing whichever way the stone itself faces, not the camera.
 */

export const MAX_TOMBSTONE_NAMES = 128;
const SLOT_WIDTH = 256;
const SLOT_HEIGHT = 64;
const SLOT_GAP = 4;
const ATLAS_COLUMNS = 8;
const ATLAS_START_ROWS = 4;
const FONT = `700 32px system-ui, 'Helvetica Neue', Arial, sans-serif`;

/** The scene an object currently sits in, or null when it is not attached (yet). */
export function sceneOf(object: THREE.Object3D): THREE.Scene | null {
  let node: THREE.Object3D | null = object;
  while (node.parent) node = node.parent;
  return (node as THREE.Scene).isScene ? (node as THREE.Scene) : null;
}

function shownInTree(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}

/**
 * An engraved nameplate handle: a plain `Object3D`, a child of the tombstone's own
 * object at a fixed local pose (near the bottom of the stone's grey face). Its
 * `userData.nameText` is read by the scene's `TombstoneNameBatch`; `setTombstoneName`
 * is the only way to change it, so the batch always knows when a slot is stale.
 */
export function tombstoneNameplate(text: string): THREE.Object3D {
  const handle = new THREE.Object3D();
  handle.name = 'tombstone-nameplate';
  // Local to the tombstone's own object (`Tombstone.ts`'s `body` spans y 0.05-0.45, z ±0.04):
  // near the bottom of the face, just proud of it so it never z-fights with the stone.
  handle.position.set(0, 0.12, 0.041);
  handle.scale.set(0.28, 0.07, 1);
  setTombstoneName(handle, text);
  return handle;
}

/** Change a nameplate's text (idempotent). The batch redraws its slot on the next frame. */
export function setTombstoneName(handle: THREE.Object3D, text: string): void {
  handle.userData.nameText = text;
}

const VERTEX = /* glsl */ `
attribute vec4 uvRect;
varying vec2 vUv;
void main() {
  // Not a billboard: the full instance matrix (translation, rotation, scale) applies, so the
  // quad inherits its handle's own orientation and reads as flush with the stone's face.
  vec4 worldPosition = instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * worldPosition;
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
 * Every engraved tombstone name of a scene in one draw call: an instanced quad
 * (full matrix, not billboarded) and one canvas atlas with a slot per name. Each
 * frame (`onBeforeRender`) copies every tracked handle's world pose into its
 * instance; a handle no longer in this scene, or hidden, gets scale 0. A slot
 * redraws only when its handle's text actually changed.
 */
export class TombstoneNameBatch {
  readonly mesh: THREE.InstancedMesh;
  private handles: THREE.Object3D[] = [];
  private drawnTexts: string[] = [];
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
    this.uvRects = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TOMBSTONE_NAMES * 4), 4);
    geometry.setAttribute('uvRect', this.uvRects);
    this.mesh = new THREE.InstancedMesh(geometry, this.material, MAX_TOMBSTONE_NAMES);
    this.mesh.name = 'tombstone-name-batch';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.raycast = () => undefined;
    this.mesh.onBeforeRender = () => this.sync();
    scene.add(this.mesh);
  }

  /** The nameplate handles this batch draws, in instance order. Tests only. */
  get labels(): readonly THREE.Object3D[] {
    return this.handles;
  }

  /** Draw this nameplate (idempotent). */
  track(handle: THREE.Object3D): void {
    if (this.handles.includes(handle) || this.handles.length >= MAX_TOMBSTONE_NAMES) return;
    this.handles.push(handle);
    this.drawnTexts.push('');
    this.mesh.count = this.handles.length;
  }

  /** Draw every nameplate under a root (a room just added to the scene, before this ran). */
  collect(root: THREE.Object3D): void {
    root.traverse((object) => {
      if (object.name === 'tombstone-nameplate') this.track(object);
    });
  }

  /**
   * Stop drawing a removed tombstone's nameplate and free its slot (issue #159 review: a
   * removed tombstone must not leak). Every handle after it shifts down one slot; forcing
   * their drawn text back to '' makes the next `sync()` redraw them into their new slot.
   */
  untrack(handle: THREE.Object3D): void {
    const index = this.handles.indexOf(handle);
    if (index === -1) return;
    this.handles.splice(index, 1);
    this.drawnTexts.splice(index, 1);
    for (let i = index; i < this.drawnTexts.length; i++) this.drawnTexts[i] = '';
    this.mesh.count = this.handles.length;
  }

  /** Copy each handle's world pose into its instance, redraw any slot whose text changed. */
  sync(): void {
    let uvChanged = false;
    for (let i = 0; i < this.handles.length; i++) {
      const handle = this.handles[i];
      const shown = sceneOf(handle) === this.scene && shownInTree(handle);
      if (!shown) {
        this.mesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      const text = String(handle.userData.nameText ?? '');
      if (this.drawnTexts[i] !== text) {
        this.drawSlot(i, text);
        this.drawnTexts[i] = text;
        uvChanged = true;
      }
      handle.updateWorldMatrix(true, false);
      this.mesh.setMatrixAt(i, handle.matrixWorld);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (uvChanged) this.uvRects.needsUpdate = true;
  }

  private newTexture(): THREE.CanvasTexture {
    const texture = new THREE.CanvasTexture(this.canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private drawSlot(index: number, text: string): void {
    if (index >= ATLAS_COLUMNS * this.rows) this.growAtlas();
    const column = index % ATLAS_COLUMNS;
    const row = Math.floor(index / ATLAS_COLUMNS);
    const x = column * SLOT_WIDTH + SLOT_GAP;
    const y = row * SLOT_HEIGHT + SLOT_GAP;
    const width = SLOT_WIDTH - SLOT_GAP * 2;
    const height = SLOT_HEIGHT - SLOT_GAP * 2;
    const ctx = this.canvas.getContext('2d');
    if (ctx?.fillRect) {
      ctx.save();
      ctx.clearRect(column * SLOT_WIDTH, row * SLOT_HEIGHT, SLOT_WIDTH, SLOT_HEIGHT);
      ctx.fillStyle = '#2a2a2e';
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + width / 2, y + height / 2, width);
      ctx.restore();
    }
    // The canvas flips on upload: canvas row 0 is the top of the texture (v = 1)
    const W = this.canvas.width;
    const H = this.canvas.height;
    this.uvRects.setXYZW(index, x / W, 1 - (y + height) / H, width / W, height / H);
    this.texture.needsUpdate = true;
  }

  /** More names than slots: a taller atlas; every slot redraws. */
  private growAtlas(): void {
    this.rows *= 2;
    this.canvas.height = SLOT_HEIGHT * this.rows;
    this.texture.dispose();
    this.texture = this.newTexture();
    this.material.uniforms.atlas.value = this.texture;
    this.drawnTexts = this.drawnTexts.map(() => '');
    for (let i = 0; i < this.handles.length; i++) {
      const text = String(this.handles[i].userData.nameText ?? '');
      if (i < ATLAS_COLUMNS * this.rows) {
        this.drawSlot(i, text);
        this.drawnTexts[i] = text;
      }
    }
  }
}

/** The scene's tombstone name batch, made on first use. */
export function tombstoneNameBatchFor(scene: THREE.Scene): TombstoneNameBatch {
  const existing = scene.userData.tombstoneNameBatch as TombstoneNameBatch | undefined;
  if (existing) return existing;
  const batch = new TombstoneNameBatch(scene);
  scene.userData.tombstoneNameBatch = batch;
  return batch;
}
