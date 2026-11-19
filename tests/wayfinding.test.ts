import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { DOOR_WIDTH, slotFor, type Door, type Rect } from '../src/addons/building/RoomPlanner.js';
import type { Activity } from '../src/agents/ActivityAnimations.js';

// Furniture paints toon gradients on a canvas; room labels draw on a canvas too.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { createOffice } = await import('../src/scene/Office.js');
const { BuildingLayout } = await import('../src/addons/building/BuildingLayout.js');
const { buildRoom, roomFloorColor, roomTitle, ROOM_LABEL_Y, WALL_HEIGHT } = await import('../src/addons/building/rooms.js');
const { buildMissionRoom } = await import('../src/addons/building/missionRooms.js');
const { applyCutaway, OVERVIEW_WALL_HEIGHT } = await import('../src/scene/Cutaway.js');
const { StaticBatch, STATIC_SOURCE_LAYER } = await import('../src/scene/StaticMerge.js');
const { FrameLoop } = await import('../src/scene/FrameLoop.js');
const { addLighting } = await import('../src/scene/SceneSetup.js');
const { OFFICE } = await import('../src/utils/Constants.js');
const {
  LabelDetailController, OVERVIEW_SIGN_ZOOM, FIRST_PERSON_SIGN_DISTANCE, roomLabelVisible, signVisible,
} = await import('../src/ui/LabelDetail.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const center = (rect: Rect) => ({ x: (rect.minX + rect.maxX) / 2, z: (rect.minZ + rect.maxZ) / 2 });

function building() {
  const scene = new THREE.Scene();
  const storage = new Map<string, string>();
  const layout = new BuildingLayout(scene, createOffice(scene), {
    now: () => 0,
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
  });
  const agent = (id: string, activity: Activity) => ({ id, activity });
  return { scene, layout, agent };
}

const labelsIn = (root: THREE.Object3D) => {
  const found: THREE.Object3D[] = [];
  root.traverse((object) => { if (object.userData.roomLabel !== undefined) found.push(object); });
  return found;
};
const framesIn = (root: THREE.Object3D) => {
  const found: THREE.Object3D[] = [];
  root.traverse((object) => { if (object.name === 'door-frame') found.push(object); });
  return found;
};

const missionRoom = (title = 'Office roadmap', sleepers = 3) => ({
  id: `room-${title}`, kind: 'mission' as const, title, state: 'open' as const, sleepers,
  walls: { statement: 'Ship it', docs: [], issues: [], kanban: [] },
});

// --- AC1: room labels ---

test('each room has one label above its center, in the world, below the wall top', () => {
  const slot = slotFor(1);
  const room = buildRoom('library', slot, 1, []);
  const labels = labelsIn(room.group);
  assert.equal(labels.length, 1);
  const [label] = labels;
  assert.ok(label instanceof THREE.Sprite, 'a world-space sprite scales with distance');
  assert.equal(label.userData.roomLabel, 'Library');
  assert.ok(Math.abs(label.position.x - center(slot.rect).x) < 1e-6 && Math.abs(label.position.z - center(slot.rect).z) < 1e-6);
  assert.equal(label.position.y, ROOM_LABEL_Y);
  const material = (label as THREE.Sprite).material;
  assert.equal(material.depthTest, true, 'walls in front hide the label in first person');
  assert.ok(ROOM_LABEL_Y + label.scale.y / 2 <= WALL_HEIGHT, 'the whole label is below the wall top');
  assert.ok(ROOM_LABEL_Y - label.scale.y / 2 > OVERVIEW_WALL_HEIGHT, 'the label stays above the lowered walls');
});

test('rooms no longer carry the small door sign chip', () => {
  const room = buildRoom('lab', slotFor(2), 2, []);
  const chips = room.group.children.filter((child) => child instanceof CSS2DObject && (child as CSS2DObject).element.classList.contains('room-sign'));
  assert.equal(chips.length, 0);
});

test('every room of the building, and every war room, gets a label', () => {
  const { scene, layout } = building();
  layout.syncWorldRooms([missionRoom('One'), missionRoom('Two')]);
  const texts = labelsIn(scene).map((label) => label.userData.roomLabel);
  assert.deepEqual(texts.sort(), ['Library', 'One', 'Two', 'Your office'].sort());
});

test('a war room label follows the mission title', () => {
  const room = buildMissionRoom(missionRoom('Old title'), 0);
  room.update({ ...missionRoom('Old title'), title: 'New title' });
  assert.equal(labelsIn(room.group)[0].userData.roomLabel, 'New title');
});

test('a room label hides in first person while the camera is inside its room, so it does not block the view', () => {
  assert.equal(roomLabelVisible({ viewMode: 'first-person', cameraInside: true }), false);
  assert.equal(roomLabelVisible({ viewMode: 'first-person', cameraInside: false }), true);
  assert.equal(roomLabelVisible({ viewMode: 'overview', cameraInside: true }), true);
});

test('the label controller applies the room label rule from the camera position', () => {
  const scene = new THREE.Scene();
  const slot = slotFor(1);
  const room = buildRoom('library', slot, 1, []);
  scene.add(room.group);
  const [label] = labelsIn(room.group);
  assert.deepEqual(label.userData.roomRect, slot.rect);
  const camera = new THREE.PerspectiveCamera(60, 16 / 10, 0.1, 500);
  const inside = center(slot.rect);
  camera.position.set(inside.x, 1.6, inside.z);
  camera.updateMatrixWorld();
  let viewMode: 'overview' | 'first-person' = 'first-person';
  const controller = new LabelDetailController({
    agents: () => [], camera, canvas: dom.window.document.createElement('canvas'), keys: dom.window, scene,
    viewMode: () => viewMode, zoomDistance: () => 40, pick: () => null, selected: () => null,
  });
  controller.refresh();
  assert.equal(label.visible, false, 'inside the room in first person');
  camera.position.set(0, 1.6, 0);
  camera.updateMatrixWorld();
  controller.refresh();
  assert.equal(label.visible, true, 'from the hall');
  camera.position.set(inside.x, 1.6, inside.z);
  viewMode = 'overview';
  controller.refresh();
  assert.equal(label.visible, true, 'always in the overview');
});

// --- AC4: lounge names ---

test('lounges are numbered in the order they are rented', () => {
  assert.equal(roomTitle('lounge', []), 'Lounge 1');
  assert.equal(roomTitle('lounge', ['office', 'lounge', 'desks', 'lounge']), 'Lounge 3');
  assert.equal(roomTitle('library', ['lounge']), 'Library');
  assert.equal(roomTitle('desks', [], 'core'), 'Desks · core');
});

test('three lounges in the building are named Lounge 1, Lounge 2 and Lounge 3', () => {
  const { scene, layout, agent } = building();
  for (let i = 0; i < 6 + 27; i++) layout.seatFor(agent(`idle-${i}`, 'idle'), null);
  assert.equal(layout.roomKinds.filter((kind) => kind === 'lounge').length, 3);
  const lounges = labelsIn(scene).map((label) => label.userData.roomLabel as string).filter((text) => text.startsWith('Lounge'));
  assert.deepEqual(lounges, ['Lounge 1', 'Lounge 2', 'Lounge 3']);
});

// --- AC2: door frames ---

function assertFrameAt(frame: THREE.Object3D, rect: Rect, door: Door, color: number) {
  const meshes = frame.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh);
  assert.equal(meshes.length, 3, 'two posts and a lintel');
  const horizontal = door.side === 'north' || door.side === 'south';
  const wallLine = { north: rect.minZ, south: rect.maxZ, west: rect.minX, east: rect.maxX }[door.side];
  const along = (mesh: THREE.Mesh) => (horizontal ? mesh.position.x : mesh.position.z);
  const across = (mesh: THREE.Mesh) => (horizontal ? mesh.position.z : mesh.position.x);
  for (const mesh of meshes) {
    assert.ok(Math.abs(across(mesh) - wallLine) < 1e-6, 'on the door wall');
    assert.equal((mesh.material as THREE.MeshToonMaterial).color.getHex(), color, 'in the room floor color');
  }
  const posts = meshes.filter((mesh) => mesh.name === 'door-post');
  const lintel = meshes.find((mesh) => mesh.name === 'door-lintel')!;
  assert.equal(posts.length, 2);
  const offsets = posts.map((post) => along(post) - door.at).sort((a, b) => a - b);
  assert.ok(offsets[0] < -DOOR_WIDTH / 2 + 0.2 && offsets[0] > -DOOR_WIDTH / 2 - 0.3, `left post at the gap edge (${offsets[0]})`);
  assert.ok(Math.abs(offsets[0] + offsets[1]) < 1e-6, 'posts are symmetric');
  assert.ok(Math.abs(along(lintel) - door.at) < 1e-6, 'lintel centered on the door');
  assert.ok(lintel.position.y > Math.max(...posts.map((post) => post.position.y)), 'lintel above the posts');
}

test('a room door has a frame of two posts and a lintel in the room floor color', () => {
  const slot = slotFor(0);
  const room = buildRoom('office', slot, 0, []);
  const frames = framesIn(room.group);
  assert.equal(frames.length, 1);
  assertFrameAt(frames[0], slot.rect, slot.door, roomFloorColor('office'));
});

test('every doorway of the building has a frame, outer rings and war rooms included', () => {
  const { scene, layout, agent } = building();
  // Fill the first ring and open an outer room (8 rooms)
  for (let i = 0; i < 6 + 9 * 6; i++) layout.seatFor(agent(`idle-${i}`, 'idle'), null);
  layout.syncWorldRooms([missionRoom('A'), missionRoom('B'), missionRoom('C')]);
  const roomCount = layout.roomKinds.length;
  assert.ok(roomCount >= 8, `an outer ring exists (${roomCount} rooms)`);
  const frames = framesIn(scene);
  assert.equal(frames.length, roomCount + 3, 'one frame per room door');
  for (let index = 0; index < roomCount; index++) {
    const slot = slotFor(index);
    const room = scene.getObjectByName(`room-${index}-${layout.roomKinds[index]}`)!;
    assertFrameAt(framesIn(room)[0], slot.rect, slot.door, roomFloorColor(layout.roomKinds[index]));
  }
});

// --- AC3: cut-away walls ---

/** Run the static merge and the cutaway once, as a frame of the render loop does. */
function frameOf(scene: THREE.Scene, statics: InstanceType<typeof StaticBatch>, overview: boolean): boolean {
  scene.updateMatrixWorld();
  statics.update();
  return applyCutaway(scene, overview);
}

/** The highest point of every drawn (camera layer) mesh under a zone container that the overview lowers. */
function drawnWallTops(scene: THREE.Scene): number[] {
  const tops: number[] = [];
  const camera = new THREE.Layers();
  for (const container of scene.children) {
    if (container.userData.overviewLower === undefined) continue;
    container.traverseVisible((object) => {
      if ((object as THREE.Mesh).isMesh && object.layers.test(camera)) tops.push(topOf(object));
    });
  }
  return tops;
}

/** Every source wall and door frame mesh of the building: none may draw itself (they draw merged). */
function sourceWalls(scene: THREE.Scene): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  scene.traverse((object) => {
    if (object.name !== 'room-walls' && object.name !== 'building-hall-walls' && object.name !== 'door-frame') return;
    object.traverse((child) => { if ((child as THREE.Mesh).isMesh && child.visible && !child.userData.overviewHidden) found.push(child as THREE.Mesh); });
  });
  return found;
}

const topOf = (mesh: THREE.Object3D) => new THREE.Box3().setFromObject(mesh).max.y;

test('room walls, door frames and hall walls draw merged in zones the overview lowers', () => {
  const { scene, layout } = building();
  layout.syncWorldRooms([missionRoom('A')]);
  const statics = new StaticBatch(scene);
  frameOf(scene, statics, false);
  const sources = sourceWalls(scene);
  assert.ok(sources.length > 20, `${sources.length} wall meshes`);
  for (const mesh of sources) assert.ok(mesh.layers.isEnabled(STATIC_SOURCE_LAYER) && !mesh.layers.isEnabled(0), `${mesh.name} draws merged`);
  const tops = drawnWallTops(scene);
  assert.ok(tops.length > 0, 'the walls draw from cutaway zones');
  assert.ok(Math.max(...tops) >= WALL_HEIGHT - 1e-6, 'first person keeps full walls');
});

test('the overview lowers the merged walls so the room floors show; first person restores full walls', () => {
  const { scene } = building();
  const statics = new StaticBatch(scene);
  frameOf(scene, statics, false);
  const before = drawnWallTops(scene);

  assert.equal(frameOf(scene, statics, true), true, 'the cutaway reports a change');
  for (const top of drawnWallTops(scene)) assert.ok(top <= OVERVIEW_WALL_HEIGHT + 1e-6, `wall top ${top}`);
  assert.equal(frameOf(scene, statics, true), false, 'a second overview frame changes nothing');

  frameOf(scene, statics, false);
  assert.deepEqual(drawnWallTops(scene), before);
});

test('walls built while the overview is on are lowered in the same frame, and stand at full height after it', () => {
  const { scene, layout, agent } = building();
  const statics = new StaticBatch(scene);
  frameOf(scene, statics, true);
  for (let i = 0; i < 6 + 9; i++) layout.seatFor(agent(`idle-${i}`, 'idle'), null);
  layout.syncWorldRooms([missionRoom('Late')]);
  frameOf(scene, statics, true);
  for (const top of drawnWallTops(scene)) assert.ok(top <= OVERVIEW_WALL_HEIGHT + 1e-6, `wall top ${top}`);
  frameOf(scene, statics, false);
  const tops = drawnWallTops(scene);
  assert.ok(Math.max(...tops) <= OFFICE.height + 1e-6, `no stretched wall (${Math.max(...tops)})`);
  assert.ok(Math.max(...tops) >= WALL_HEIGHT - 1e-6);
});

test('the activity layout scene does not change in the overview', () => {
  const scene = new THREE.Scene();
  createOffice(scene);
  const original: THREE.Object3D[] = [];
  scene.traverse((object) => original.push(object));
  const snapshot = () => original.map((object) => `${object.uuid}:${object.visible}:${object.scale.toArray()}:${object.position.toArray()}`);
  const before = snapshot();
  const statics = new StaticBatch(scene);
  frameOf(scene, statics, false);
  const merged = snapshot();
  assert.equal(frameOf(scene, statics, true), false);
  assert.deepEqual(snapshot(), merged);
  assert.equal(before.length, merged.length);
});

test('the render loop applies the cutaway in the frame of the mode switch and redraws the shadows', () => {
  const { scene } = building();
  addLighting(scene);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(-12, 5.5, 11);
  let mode: 'first-person' | 'overview' = 'first-person';
  let renders = 0;
  const renderer = {
    render: () => { renders++; }, info: { render: { calls: 0, triangles: 0 } },
    shadowMap: { needsUpdate: false, type: THREE.PCFSoftShadowMap }, getPixelRatio: () => 1, setPixelRatio: () => undefined,
  };
  const loop = new FrameLoop({
    scene, camera, renderer: renderer as never, labelRenderer: { render: () => undefined },
    update: () => undefined, figures: () => [], mode: () => mode,
  });
  loop.frame(0);
  mode = 'overview';
  const before = renders;
  loop.frame(1000);
  assert.equal(renders, before + 1);
  for (const top of drawnWallTops(scene)) assert.ok(top <= OVERVIEW_WALL_HEIGHT + 1e-6, `wall top ${top}`);
});

// --- AC5: quieter mission signs ---

const view = (overrides: Partial<{ mode: 'smart' | 'all'; viewMode: 'overview' | 'first-person'; zoomDistance: number }> = {}) =>
  ({ mode: 'smart' as const, viewMode: 'overview' as const, zoomDistance: OVERVIEW_SIGN_ZOOM + 20, ...overrides });

test('a mission sign shows only when you zoom in or hover; the past sessions sign only on hover', () => {
  const far = FIRST_PERSON_SIGN_DISTANCE + 5;
  assert.equal(signVisible({ hovered: false, distance: far, hoverOnly: false }, view()), false);
  assert.equal(signVisible({ hovered: false, distance: far, hoverOnly: false }, view({ zoomDistance: OVERVIEW_SIGN_ZOOM })), true);
  assert.equal(signVisible({ hovered: true, distance: far, hoverOnly: false }, view()), true);
  assert.equal(signVisible({ hovered: false, distance: far, hoverOnly: true }, view({ zoomDistance: 3 })), false);
  assert.equal(signVisible({ hovered: true, distance: far, hoverOnly: true }, view()), true);
  // First person: near signs show, far ones do not
  assert.equal(signVisible({ hovered: false, distance: FIRST_PERSON_SIGN_DISTANCE, hoverOnly: false }, view({ viewMode: 'first-person' })), true);
  assert.equal(signVisible({ hovered: false, distance: far, hoverOnly: false }, view({ viewMode: 'first-person' })), false);
  // Labels: all shows every sign
  assert.equal(signVisible({ hovered: false, distance: far, hoverOnly: true }, view({ mode: 'all' })), true);
});

test('war room signs are marked as detail signs with their room', () => {
  const room = buildMissionRoom(missionRoom('Roadmap', 2), 0);
  const signs = room.group.children.filter((child): child is CSS2DObject => child instanceof CSS2DObject);
  assert.ok(signs.length >= 2);
  for (const sign of signs) {
    assert.deepEqual(sign.userData.detailSign.rect, room.slot.rect);
    assert.equal(sign.element.dataset.sign, 'mission');
  }
  const sleepers = signs.find((sign) => /past session/.test(sign.element.textContent ?? ''))!;
  assert.equal(sleepers.userData.detailSign.hoverOnly, true);
});

test('the label controller hides war room signs in the default overview and shows them when zoomed in', () => {
  const scene = new THREE.Scene();
  const room = buildMissionRoom(missionRoom('Roadmap', 2), 0);
  scene.add(room.group);
  const camera = new THREE.PerspectiveCamera(60, 16 / 10, 0.1, 500);
  camera.position.set(0, 60, 40);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const canvas = dom.window.document.createElement('canvas');
  const state = { zoom: OVERVIEW_SIGN_ZOOM + 30 };
  const controller = new LabelDetailController({
    agents: () => [], camera, canvas, keys: dom.window, scene,
    viewMode: () => 'overview', zoomDistance: () => state.zoom, pick: () => null, selected: () => null,
  });
  const signs = room.group.children.filter((child): child is CSS2DObject => child instanceof CSS2DObject);
  controller.refresh();
  assert.ok(signs.every((sign) => sign.element.style.visibility === 'hidden'));
  state.zoom = OVERVIEW_SIGN_ZOOM - 1;
  controller.refresh();
  const title = signs.find((sign) => sign.element.textContent === 'Roadmap')!;
  assert.equal(title.element.style.visibility, '');
  const sleepers = signs.find((sign) => /past session/.test(sign.element.textContent ?? ''))!;
  assert.equal(sleepers.element.style.visibility, 'hidden', 'past sessions wait for a hover');
});

test('the "You" sign at the user desk is a detail sign too, so it does not cover the queue in the overview', () => {
  const slot = slotFor(0);
  const room = buildRoom('office', slot, 0, []);
  const you = room.group.children.find((child): child is CSS2DObject => child instanceof CSS2DObject && child.element.textContent === 'You')!;
  assert.deepEqual(you.userData.detailSign, { rect: slot.rect, hoverOnly: false });
});
