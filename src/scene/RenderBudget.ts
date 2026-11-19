import * as THREE from 'three';

/** The draw-call budget per frame at the real size (25 rooms, 40 agents). */
export const DRAW_CALL_BUDGET = 500;

export interface DrawCallCount {
  /** Meshes the camera pass draws (an instanced or merged mesh is one call). */
  main: number;
  /** Meshes that cast a shadow. */
  shadowCasters: number;
  /** Lights that cast a shadow; each draws every caster into its shadow map. */
  shadowLights: number;
  /** Worst frame: the camera pass plus a full shadow map update. */
  total: number;
}

function callsOf(object: THREE.Mesh): number {
  if ((object as THREE.InstancedMesh).isInstancedMesh && (object as THREE.InstancedMesh).count === 0) return 0;
  const material = object.material;
  if (Array.isArray(material)) return object.geometry.groups.filter((group) => material[group.materialIndex ?? 0]?.visible).length;
  return material.visible ? 1 : 0;
}

/**
 * Count the draw calls of one frame without a GPU, the way WebGLRenderer
 * decides: visible objects on a camera layer, one call per mesh and visible
 * material, one per sprite. Frustum culling is ignored, so the count is the worst case.
 */
export function countDrawCalls(scene: THREE.Object3D, cameraLayers = new THREE.Layers()): DrawCallCount {
  let main = 0;
  let shadowCasters = 0;
  let shadowLights = 0;
  scene.traverseVisible((object) => {
    if ((object as THREE.Light).isLight && (object as THREE.Light).castShadow) shadowLights++;
    // A sprite (a room label) is one camera draw call; three draws no sprite into a shadow map
    if ((object as THREE.Sprite).isSprite && object.layers.test(cameraLayers)) {
      if ((object as THREE.Sprite).material.visible) main++;
      return;
    }
    if (!(object as THREE.Mesh).isMesh || !object.layers.test(cameraLayers)) return;
    const calls = callsOf(object as THREE.Mesh);
    main += calls;
    if (object.castShadow) shadowCasters += calls;
  });
  return { main, shadowCasters, shadowLights, total: main + shadowCasters * shadowLights };
}

/** A number that changes when the set of drawn shadow casters changes (a board or a hat was added). */
export function casterSignature(scene: THREE.Object3D, cameraLayers = new THREE.Layers()): number {
  let hash = 0x811c9dc5;
  scene.traverseVisible((object) => {
    if ((object as THREE.Mesh).isMesh && object.castShadow && object.layers.test(cameraLayers)) {
      hash = Math.imul(hash ^ object.id, 0x01000193) >>> 0;
    }
  });
  return hash;
}
