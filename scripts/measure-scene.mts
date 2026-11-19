// Measure the static weight of the office scene at the real size (25 rooms, 40 agents, hats and cards), without a browser.
// Run: pnpm measure   (prints the draw calls before and after the static merge and the figure batch;
// `views` culls like the renderer from the first-person start pose and the overview)
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
const { buildRealSizeOffice, realSizeCameras, REAL_SIZE } = await import('../tests/real-size-office.js');
const { countDrawCalls } = await import('../src/scene/RenderBudget.js');
const { StaticBatch } = await import('../src/scene/StaticMerge.js');
const { FigureBatch } = await import('../src/characters/FigureBatch.js');
const { CSS2DObject } = await import('three/addons/renderers/CSS2DRenderer.js');

function weight(scene: THREE.Scene) {
  let meshes = 0;
  let triangles = 0;
  let labels = 0;
  const geometries = new Set<unknown>();
  const materials = new Set<unknown>();
  const cameraLayers = new THREE.Layers();
  scene.traverseVisible((object) => {
    if (object instanceof CSS2DObject) labels++;
    if (!(object instanceof THREE.Mesh) || !object.layers.test(cameraLayers)) return;
    meshes++;
    geometries.add(object.geometry);
    materials.add(object.material);
    const geometry = object.geometry as THREE.BufferGeometry;
    const perInstance = (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
    triangles += perInstance * ((object as THREE.InstancedMesh).isInstancedMesh ? (object as THREE.InstancedMesh).count : 1);
  });
  return { meshes, triangles: Math.round(triangles), uniqueGeometries: geometries.size, uniqueMaterials: materials.size, css2dLabels: labels, drawCalls: countDrawCalls(scene) };
}

const { scene, manager } = buildRealSizeOffice();
scene.updateMatrixWorld();
const before = weight(scene);
const started = performance.now();
new StaticBatch(scene).update();
const mergeMs = performance.now() - started;
new FigureBatch(scene).sync(manager.getAgents().map((managed) => managed.figure.group));
const after = weight(scene);
const cameras = realSizeCameras(scene);
const views = { firstPerson: countDrawCalls(scene, cameras.firstPerson), overview: countDrawCalls(scene, cameras.overview) };
const size = { rooms: REAL_SIZE.buildingRooms + REAL_SIZE.missionRooms, agents: REAL_SIZE.agents, hatWearers: REAL_SIZE.hatWearers, cardHolders: REAL_SIZE.cardHolders };
console.log(JSON.stringify({ size, before, after, views, mergeMs: Math.round(mergeMs) }, null, 1));
dom.window.close();
