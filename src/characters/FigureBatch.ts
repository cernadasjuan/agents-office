import * as THREE from 'three';

/**
 * Draws the body parts of every stick figure as instanced meshes: one draw call
 * per part shape and color instead of 14 per figure.
 *
 * The figures keep their skeleton (joints, poses, hats on the head, a book in the
 * hand). Each part mesh (`userData.figurePart`, see StickFigureParts.ts) only
 * moves to `FIGURE_PART_LAYER`, which no camera renders but `pickAgent` still
 * hits. Objects attached to a part stay on the default layer and draw as before,
 * unless they are marked as figure parts too (the BMAD hats, which share their
 * shapes): those join the batch on the next sync.
 *
 * A part may also carry `userData.tint` (a `THREE.Color` multiplier, issue #125
 * part 3): written to the bucket's `instanceColor` buffer instead of a second
 * material, so a part that needs more color variety than its bucket's one shared
 * material (a mission's hand color, say) costs no extra draw call.
 */
export const FIGURE_PART_LAYER = 30;
const PART_LAYER_MASK = 1 << FIGURE_PART_LAYER;

const EPSILON = 1e-6;
const INITIAL_CAPACITY = 64;

export interface FigureSync {
  /** Figure roots whose parts moved since the last sync. */
  moved: THREE.Object3D[];
  /** A figure came, left, or a part changed its shape or color. */
  changed: boolean;
}

interface Bucket {
  mesh: THREE.InstancedMesh;
  parts: THREE.Mesh[];
}

function mix(hash: number, value: number): number {
  return Math.imul(hash ^ value, 0x01000193) >>> 0;
}

const materialNumbers = new WeakMap<THREE.Material, number>();
let nextMaterialNumber = 1;

function materialNumber(material: THREE.Material): number {
  let number = materialNumbers.get(material);
  if (number === undefined) {
    number = nextMaterialNumber++;
    materialNumbers.set(material, number);
  }
  return number;
}

function isShown(part: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = part; node; node = node.parent) {
    if (!node.visible) return false;
    if (node === root) return root.parent !== null;
  }
  return false;
}

export class FigureBatch {
  private buckets = new Map<string, Bucket>();
  private layout = 0;

  constructor(private parent: THREE.Object3D) {}

  /** Copy the parts' world matrices into the instanced meshes. Call after `updateMatrixWorld`. */
  sync(roots: THREE.Object3D[]): FigureSync {
    const wanted = new Map<string, THREE.Mesh[]>();
    const owner = new Map<THREE.Mesh, THREE.Object3D>();
    for (const root of roots) {
      for (const part of this.parts(root)) {
        if (!isShown(part, root)) continue;
        const key = `${part.geometry.uuid}|${(part.material as THREE.Material).uuid}`;
        const list = wanted.get(key) ?? [];
        list.push(part);
        wanted.set(key, list);
        owner.set(part, root);
      }
    }

    let layout = 0x811c9dc5;
    for (const parts of wanted.values()) {
      for (const part of parts) layout = mix(mix(mix(layout, part.id), part.geometry.id), materialNumber(part.material as THREE.Material));
      layout = mix(layout, 0xffff);
    }
    const changed = layout !== this.layout;
    this.layout = layout;

    const moved = new Set<THREE.Object3D>();
    for (const [key, parts] of wanted) {
      const bucket = this.bucketFor(key, parts[0], parts.length);
      const array = bucket.mesh.instanceMatrix.array as Float32Array;
      const colors = bucket.mesh.instanceColor!.array as Float32Array;
      let dirty = changed;
      let colorDirty = changed;
      parts.forEach((part, i) => {
        const source = part.matrixWorld.elements;
        const offset = i * 16;
        let differs = false;
        for (let k = 0; k < 16; k++) {
          // The buffer holds float32: compare at that precision, or a far figure always looks moved
          const value = Math.fround(source[k]);
          if (!(Math.abs(array[offset + k] - value) <= EPSILON)) {
            differs = true;
            array[offset + k] = value;
          }
        }
        if (differs) {
          dirty = true;
          moved.add(owner.get(part)!);
        }
        // A per-instance color multiplier (issue #125 part 3): white (1,1,1, a no-op multiply)
        // unless the part sets its own tint, so a mission's hand color costs no new bucket.
        const tint = part.userData.tint as THREE.Color | undefined;
        const cOffset = i * 3;
        const r = tint ? tint.r : 1;
        const g = tint ? tint.g : 1;
        const b = tint ? tint.b : 1;
        if (colors[cOffset] !== r || colors[cOffset + 1] !== g || colors[cOffset + 2] !== b) {
          colors[cOffset] = r;
          colors[cOffset + 1] = g;
          colors[cOffset + 2] = b;
          colorDirty = true;
        }
      });
      bucket.parts = parts;
      bucket.mesh.count = parts.length;
      bucket.mesh.visible = parts.length > 0;
      bucket.mesh.castShadow = parts.some((part) => part.castShadow);
      bucket.mesh.receiveShadow = parts.some((part) => part.receiveShadow);
      if (dirty) bucket.mesh.instanceMatrix.needsUpdate = true;
      if (colorDirty) bucket.mesh.instanceColor!.needsUpdate = true;
    }
    for (const [key, bucket] of this.buckets) {
      if (wanted.has(key)) continue;
      bucket.parts = [];
      bucket.mesh.count = 0;
      bucket.mesh.visible = false;
    }
    return { moved: [...moved], changed };
  }

  /** The instanced meshes in use, for tests and the draw-call count. */
  get meshes(): THREE.InstancedMesh[] {
    return [...this.buckets.values()].filter((bucket) => bucket.mesh.visible).map((bucket) => bucket.mesh);
  }

  /** The figure parts under a root, found again on each sync so that parts attached later join. */
  private parts(root: THREE.Object3D): THREE.Mesh[] {
    const parts: THREE.Mesh[] = [];
    root.traverse((object) => {
      if (!(object as THREE.Mesh).isMesh || !object.userData.figurePart) return;
      if (object.layers.mask !== PART_LAYER_MASK) object.layers.set(FIGURE_PART_LAYER);
      parts.push(object as THREE.Mesh);
    });
    return parts;
  }

  private bucketFor(key: string, sample: THREE.Mesh, count: number): Bucket {
    let bucket = this.buckets.get(key);
    if (bucket && bucket.mesh.instanceMatrix.count >= count) return bucket;
    let capacity = bucket ? bucket.mesh.instanceMatrix.count : INITIAL_CAPACITY;
    while (capacity < count) capacity *= 2;
    if (bucket) {
      this.parent.remove(bucket.mesh);
      bucket.mesh.dispose();
    }
    const mesh = new THREE.InstancedMesh(sample.geometry, sample.material, capacity);
    mesh.name = 'figure-batch';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // A per-instance color multiplier (issue #125 part 3): lets one part (e.g. a mission's
    // hand color) vary per instance without a second material, so it costs no extra bucket.
    // three.js applies this in the shader whenever `instanceColor` is set, for any material.
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    // Every instance moves; a bounding sphere would need a rebuild each frame
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.count = 0;
    this.parent.add(mesh);
    bucket = { mesh, parts: [] };
    this.buckets.set(key, bucket);
    // A new buffer holds no matrices yet: the caller writes all of them
    (mesh.instanceMatrix.array as Float32Array).fill(Number.NaN);
    // White: a no-op color multiply, the default for every part until it sets its own tint
    (mesh.instanceColor.array as Float32Array).fill(1);
    return bucket;
  }
}
