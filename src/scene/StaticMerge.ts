import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Static furniture merge. A root marked with `markStatic` (the hall, a room, a
 * lamp) holds furniture that does not move. `StaticBatch.update` merges its
 * meshes into one mesh per material and shadow flags, so the whole building
 * costs tens of draw calls instead of thousands.
 *
 * The source meshes stay in the scene graph (names, `visible`, `getObjectByName`
 * and wall rebuilds keep working); they only move to `STATIC_SOURCE_LAYER`, which
 * no camera renders. A batch rebuilds when its sources change: a mesh is added or
 * removed, or its visibility changes.
 *
 * Never merged, so they keep their own draw call and can change: meshes whose
 * material is not a `MeshToonMaterial` (canvas boards), transparent meshes, and
 * meshes under an object marked `userData.dynamic` or `userData.overviewHidden`.
 */
export const STATIC_SOURCE_LAYER = 31;

const MARK = 'staticBatch';
const MERGED = 'staticMerged';

export interface StaticOptions {
  /**
   * Roots with the same zone share merged meshes (a zone container at the scene
   * root). Without a zone the merged meshes go inside the root itself, so they
   * follow its visibility (a lamp hidden in the overview).
   */
  zone?: string;
  /** False: the merged meshes cast no shadow (rooms outside the hall lamps' reach). */
  castShadow?: boolean;
}

interface StaticMark {
  zone: string | null;
  castShadow: boolean;
}

export function markStatic(root: THREE.Object3D, options: StaticOptions = {}): void {
  root.userData[MARK] = { zone: options.zone ?? null, castShadow: options.castShadow ?? true } satisfies StaticMark;
}

interface Batch {
  container: THREE.Object3D;
  castShadow: boolean;
  signature: number;
  sources: THREE.Mesh[];
  excluded: THREE.Mesh[];
  merged: THREE.Mesh[];
  seen: boolean;
}

function mix(hash: number, value: number): number {
  return Math.imul(hash ^ value, 0x01000193) >>> 0;
}

function isMergeable(mesh: THREE.Mesh): boolean {
  const material = mesh.material;
  if (Array.isArray(material)) return false;
  if ((mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return false;
  if (!(material as THREE.MeshToonMaterial).isMeshToonMaterial || material.transparent) return false;
  return mesh.geometry?.attributes.position !== undefined && Object.keys(mesh.geometry.morphAttributes).length === 0;
}

function geometryKey(geometry: THREE.BufferGeometry): string {
  const attributes = Object.keys(geometry.attributes).sort().map((name) => `${name}${geometry.attributes[name].itemSize}`);
  return `${geometry.index ? 'i' : 'n'}:${attributes.join(',')}`;
}

export class StaticBatch {
  private batches = new Map<string, Batch>();
  private readonly toContainer = new THREE.Matrix4();

  constructor(private scene: THREE.Scene) {}

  /** Rebuild every batch whose sources changed. True when a batch was rebuilt. */
  update(): boolean {
    for (const batch of this.batches.values()) {
      batch.seen = false;
      batch.sources = [];
      batch.excluded = [];
    }
    const signatures = new Map<string, number>();
    this.collect(this.scene, null, true, false, signatures);

    let rebuilt = false;
    for (const [key, batch] of this.batches) {
      const signature = signatures.get(key) ?? 0;
      if (!batch.seen) {
        this.clear(batch);
        if (batch.container.userData[MERGED] && batch.container.parent) batch.container.parent.remove(batch.container);
        this.batches.delete(key);
        rebuilt = true;
        continue;
      }
      if (batch.signature === signature) continue;
      batch.signature = signature;
      this.rebuild(batch);
      rebuilt = true;
    }
    return rebuilt;
  }

  /** The merged meshes, for tests and the debug view. */
  get mergedMeshes(): THREE.Mesh[] {
    return [...this.batches.values()].flatMap((batch) => batch.merged);
  }

  private collect(object: THREE.Object3D, batchKey: string | null, visible: boolean, blocked: boolean, signatures: Map<string, number>): void {
    if (object.userData[MERGED]) return;
    let key = batchKey;
    let isBlocked = blocked;
    const mark = object.userData[MARK] as StaticMark | undefined;
    if (mark) {
      key = mark.zone ? `zone:${mark.zone}` : `root:${object.uuid}`;
      this.batchFor(key, mark, object).seen = true;
      // An in-place root keeps its own overview flag: the merged meshes inside it follow it
      isBlocked = mark.zone ? Boolean(object.userData.overviewHidden || object.userData.dynamic) : false;
    } else if (key && (object.userData.overviewHidden || object.userData.dynamic)) {
      isBlocked = true;
    }
    // An in-place root's own visibility does not matter: its merged meshes inside it follow it
    const isVisible = mark && !mark.zone ? true : visible && object.visible;

    if (key && (object as THREE.Mesh).isMesh) {
      const mesh = object as THREE.Mesh;
      const batch = this.batches.get(key)!;
      const merge = isVisible && !isBlocked && isMergeable(mesh);
      if (merge) batch.sources.push(mesh);
      else batch.excluded.push(mesh);
      let hash = signatures.get(key) ?? 0x811c9dc5;
      hash = mix(mix(hash, mesh.id), merge ? 1 : 0);
      signatures.set(key, hash);
    }
    for (const child of object.children) this.collect(child, key, isVisible, isBlocked, signatures);
  }

  private batchFor(key: string, mark: StaticMark, root: THREE.Object3D): Batch {
    let batch = this.batches.get(key);
    if (!batch) {
      let container: THREE.Object3D = root;
      if (mark.zone) {
        container = new THREE.Group();
        container.name = `static-batch-${mark.zone}`;
        container.userData[MERGED] = true;
        this.scene.add(container);
      }
      batch = { container, castShadow: mark.castShadow, signature: 0, sources: [], excluded: [], merged: [], seen: false };
      this.batches.set(key, batch);
    }
    return batch;
  }

  private clear(batch: Batch): void {
    for (const mesh of batch.merged) {
      mesh.parent?.remove(mesh);
      mesh.geometry.dispose();
    }
    batch.merged = [];
  }

  private rebuild(batch: Batch): void {
    this.clear(batch);
    this.scene.updateMatrixWorld();
    // Meshes that left the merge (hidden, now dynamic) draw themselves again
    for (const mesh of batch.excluded) {
      mesh.layers.enable(0);
      mesh.layers.disable(STATIC_SOURCE_LAYER);
    }

    const groups = new Map<string, THREE.Mesh[]>();
    for (const mesh of batch.sources) {
      const material = mesh.material as THREE.Material;
      const castShadow = batch.castShadow && mesh.castShadow;
      const key = `${material.uuid}|${castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}|${geometryKey(mesh.geometry)}`;
      const list = groups.get(key) ?? [];
      list.push(mesh);
      groups.set(key, list);
    }

    const inverse = new THREE.Matrix4().copy(batch.container.matrixWorld).invert();
    for (const meshes of groups.values()) {
      const geometries = meshes.map((mesh) => {
        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(this.toContainer.multiplyMatrices(inverse, mesh.matrixWorld));
        return geometry;
      });
      const merged = mergeGeometries(geometries, false);
      for (const geometry of geometries) geometry.dispose();
      if (!merged) continue;
      const first = meshes[0];
      const mesh = new THREE.Mesh(merged, first.material);
      mesh.name = 'static-merged';
      mesh.castShadow = batch.castShadow && first.castShadow;
      mesh.receiveShadow = first.receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.userData[MERGED] = true;
      batch.container.add(mesh);
      mesh.updateMatrixWorld(true);
      batch.merged.push(mesh);
      for (const source of meshes) source.layers.set(STATIC_SOURCE_LAYER);
    }
  }
}
