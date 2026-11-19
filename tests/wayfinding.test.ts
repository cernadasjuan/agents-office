import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { DOOR_WIDTH, slotFor, type Door, type Rect } from '../src/addons/building/RoomPlanner.js';
import type { Activity } from '../src/agents/ActivityAnimations.js';
import type { LayoutStrategy } from '../src/layout/LayoutStrategy.js';

// Furniture paints toon gradients on a canvas; room labels draw on a canvas too.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { createOffice } = await import('../src/scene/Office.js');
const { BuildingLayout } = await import('../src/addons/building/BuildingLayout.js');
const { buildRoom, buildWalls, roomFloorColor, roomTitle, ROOM_LABEL_Y, WALL_HEIGHT } = await import('../src/addons/building/rooms.js');
const { buildMissionRoom } = await import('../src/addons/building/missionRooms.js');
const { ViewController, OVERVIEW_WALL_HEIGHT } = await import('../src/scene/ViewController.js');
const { AgentManager } = await import('../src/agents/AgentManager.js');
const { SelectionState } = await import('../src/scene/Selection.js');
const {
  LabelDetailController, OVERVIEW_SIGN_ZOOM, FIRST_PERSON_SIGN_DISTANCE, signVisible,
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

test('room walls and hall walls are marked to be lowered in the overview, hidden walls stay hidden', () => {
  const walls = buildWalls({ minX: 0, maxX: 12, minZ: 0, maxZ: 12 }, [{ side: 'west', at: 6 }], 6, ['south']);
  for (const wall of walls.children) {
    if (wall.userData.overviewHidden) continue;
    assert.equal(wall.userData.overviewLower, true);
  }
  assert.ok(walls.children.some((wall) => wall.userData.overviewHidden), 'the south side is still hidden');
});

function viewOver(scene: THREE.Scene) {
  const document = dom.window.document;
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(-12, 5.5, 11);
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const empty: LayoutStrategy = { id: 'none', seatFor: () => null, release: () => undefined };
  const manager = new AgentManager(new THREE.Scene(), empty);
  const view = new ViewController({ camera, canvas, scene, selection: new SelectionState(), agents: () => manager.getAgents(), keys: dom.window });
  const press = (code: string) => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code, key: code }));
  return { view, press };
}

const topOf = (mesh: THREE.Object3D) => new THREE.Box3().setFromObject(mesh).max.y;

test('the overview lowers the walls so the room floors show; first person restores full walls', () => {
  const { scene } = building();
  const { view, press } = viewOver(scene);
  const walls: THREE.Mesh[] = [];
  scene.traverse((object) => { if (object.userData.overviewLower) walls.push(object as THREE.Mesh); });
  assert.ok(walls.length > 10);
  const before = walls.map(topOf);

  press('KeyO');
  assert.equal(view.mode, 'overview');
  for (const wall of walls) assert.ok(Math.abs(topOf(wall) - OVERVIEW_WALL_HEIGHT) < 1e-6, `wall top ${topOf(wall)}`);
  for (const wall of walls) assert.ok(new THREE.Box3().setFromObject(wall).min.y > -1e-6, 'the wall stays on the floor');

  press('KeyO');
  assert.deepEqual(walls.map(topOf), before);
});

test('walls built while the overview is on are lowered too', () => {
  const { scene, layout, agent } = building();
  const { view, press } = viewOver(scene);
  press('KeyO');
  for (let i = 0; i < 6 + 9; i++) layout.seatFor(agent(`idle-${i}`, 'idle'), null);
  view.update(1, 1);
  const tall: THREE.Object3D[] = [];
  scene.traverse((object) => {
    if (object.userData.overviewLower && object.visible && topOf(object) > OVERVIEW_WALL_HEIGHT + 1e-6) tall.push(object);
  });
  assert.equal(tall.length, 0);
});

test('the activity layout scene does not change in the overview, except its marked walls', () => {
  const scene = new THREE.Scene();
  createOffice(scene);
  const original: THREE.Object3D[] = [];
  scene.traverse((object) => { if (!object.userData.overviewHidden) original.push(object); });
  const snapshot = () => original.map((object) => `${object.uuid}:${object.visible}:${object.scale.toArray()}:${object.position.toArray()}`);
  const before = snapshot();
  const { view, press } = viewOver(scene);
  press('KeyO');
  view.update(1, 1);
  assert.deepEqual(snapshot(), before);
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
