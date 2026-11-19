import * as THREE from 'three';

/** The draw-call budget per frame at the real size (25 rooms, 40 agents). */
export const DRAW_CALL_BUDGET = 500;

export interface DrawCallCount {
  /** Meshes the camera pass draws (an instanced or merged mesh is one call). */
  main: number;
  /** Meshes that cast a shadow, before culling. */
  shadowCasters: number;
  /** Lights that cast a shadow; each draws its casters into its shadow map. */
  shadowLights: number;
  /** Calls of a full shadow map update: per light, the casters it sees (all of them without a camera). */
  shadowCalls: number;
  /** Worst frame: the camera pass plus a full shadow map update. */
  total: number;
}

function callsOf(object: THREE.Mesh): number {
  if ((object as THREE.InstancedMesh).isInstancedMesh && (object as THREE.InstancedMesh).count === 0) return 0;
  const material = object.material;
  if (Array.isArray(material)) return object.geometry.groups.filter((group) => material[group.materialIndex ?? 0]?.visible).length;
  return material.visible ? 1 : 0;
}

function inFrustum(object: THREE.Object3D, frustum: THREE.Frustum | null): boolean {
  return !frustum || !object.frustumCulled || frustum.intersectsObject(object);
}

interface ShadowView {
  frustum: THREE.Frustum | null;
  viewports: number;
}

type ShadowLight = THREE.Light & { shadow: THREE.LightShadow };

function shadowViews(lights: ShadowLight[], cull: boolean): ShadowView[] {
  return lights.map((light) => {
    const shadow = light.shadow;
    if (!cull || (light as THREE.PointLight).isPointLight) return { frustum: null, viewports: shadow.getViewportCount() };
    light.updateMatrixWorld();
    (light as THREE.SpotLight).target?.updateMatrixWorld();
    shadow.updateMatrices(light);
    return { frustum: shadow.getFrustum().clone(), viewports: 1 };
  });
}

/**
 * Count the draw calls of one frame without a GPU, the way WebGLRenderer
 * decides: visible objects on a camera layer, one call per mesh and visible
 * material. With a camera the count culls like the renderer: the camera pass
 * keeps the meshes in the camera frustum, and each shadow map keeps the
 * casters in its light's frustum. Without a camera nothing is culled, so the
 * count is the worst case. The caller updates the world matrices first.
 */
export function countDrawCalls(scene: THREE.Object3D, camera?: THREE.Camera): DrawCallCount {
  const cameraLayers = camera?.layers ?? new THREE.Layers();
  let cameraFrustum: THREE.Frustum | null = null;
  if (camera) {
    cameraFrustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      camera.coordinateSystem,
    );
  }
  const lights: ShadowLight[] = [];
  const casters: Array<{ object: THREE.Mesh; calls: number }> = [];
  let main = 0;
  scene.traverseVisible((object) => {
    const light = object as ShadowLight;
    if (light.isLight && light.castShadow && light.shadow) lights.push(light);
    if (!(object as THREE.Mesh).isMesh || !object.layers.test(cameraLayers)) return;
    const calls = callsOf(object as THREE.Mesh);
    if (inFrustum(object, cameraFrustum)) main += calls;
    if (object.castShadow) casters.push({ object: object as THREE.Mesh, calls });
  });
  let shadowCalls = 0;
  for (const view of shadowViews(lights, camera !== undefined)) {
    for (const caster of casters) if (inFrustum(caster.object, view.frustum)) shadowCalls += caster.calls * view.viewports;
  }
  const shadowCasters = casters.reduce((sum, caster) => sum + caster.calls, 0);
  return { main, shadowCasters, shadowLights: lights.length, shadowCalls, total: main + shadowCalls };
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
