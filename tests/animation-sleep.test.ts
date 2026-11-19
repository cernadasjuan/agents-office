import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// Toon materials paint a gradient on a canvas at import time; labels need a document.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { AgentManager } = await import('../src/agents/AgentManager.js');
const { FrameLoop } = await import('../src/scene/FrameLoop.js');
const { isAnimationAsleep, setAnimationAsleep, ANIMATION_DISTANCE } = await import('../src/scene/AnimationSleep.js');
const { FrameStats } = await import('../src/scene/RenderScheduler.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const frameTimes = (seconds: number, hz = 60) => Array.from({ length: seconds * hz }, (_, i) => (i * 1000) / hz);

function seat(x: number, z: number) {
  return { key: `s${x},${z}`, position: new THREE.Vector3(x, 0, z), lookAt: new THREE.Vector3(x, 0, z - 1) };
}

/** A layout that seats each agent where the test says. */
function fixedLayout(places: Map<string, ReturnType<typeof seat>>) {
  return { seatFor: (info: { id: string }) => places.get(info.id) ?? null, release: () => undefined };
}

function rotations(root: THREE.Object3D): number[] {
  const values: number[] = [];
  root.traverse((object) => values.push(object.rotation.x, object.rotation.y, object.rotation.z, object.position.y));
  return values;
}

test('an asleep figure that sits still does not animate; an awake one does; an asleep one still walks', () => {
  const places = new Map([['awake', seat(0, 0)], ['asleep', seat(3, 0)], ['walker', seat(6, 0)]]);
  const manager = new AgentManager(new THREE.Scene(), fixedLayout(places) as never);
  for (const id of places.keys()) manager.addAgent({ id, name: id, activity: 'implementing' });
  const [awake, asleep, walker] = manager.getAgents();
  for (let i = 1; i <= 30; i++) manager.update(i / 30, 1 / 30);
  setAnimationAsleep(asleep.figure.group, true);
  setAnimationAsleep(walker.figure.group, true);
  places.set('walker', seat(6, 8));
  manager.setActivity('walker', 'implementing');
  manager.setExtras('walker', undefined);

  const awakeBefore = rotations(awake.figure.group);
  const asleepBefore = rotations(asleep.figure.group);
  for (let i = 31; i <= 60; i++) manager.update(i / 30, 1 / 30);
  assert.notDeepEqual(rotations(awake.figure.group), awakeBefore);
  assert.deepEqual(rotations(asleep.figure.group), asleepBefore);
  assert.ok(walker.figure.group.position.z > 1, `the walker moved to z=${walker.figure.group.position.z}`);
  assert.equal(isAnimationAsleep(awake.figure.group), false);
});

interface FakeRenderer {
  renders: number;
  shadowUpdates: number;
  render(): void;
  info: { render: { calls: number; triangles: number }; autoReset: boolean; reset(): void };
  shadowMap: { needsUpdate: boolean; type: THREE.ShadowMapType };
  getPixelRatio(): number;
  setPixelRatio(value: number): void;
}

function fakeRenderer(): FakeRenderer {
  const renderer: FakeRenderer = {
    renders: 0,
    shadowUpdates: 0,
    info: { render: { calls: 0, triangles: 0 }, autoReset: true, reset: () => undefined },
    shadowMap: { needsUpdate: false, type: THREE.PCFShadowMap },
    render() {
      renderer.renders++;
      if (renderer.shadowMap.needsUpdate) renderer.shadowUpdates++;
      renderer.shadowMap.needsUpdate = false;
    },
    getPixelRatio: () => 1,
    setPixelRatio: () => undefined,
  };
  return renderer;
}

/** 40 agents at their idle animation: 39 behind the camera or far away, and optionally one near and in view. */
function crowd(withNearOne: boolean) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 200);
  camera.position.set(0, 1.6, 10);
  camera.lookAt(0, 1, 0);
  const places = new Map<string, ReturnType<typeof seat>>();
  for (let i = 0; i < 39; i++) places.set(`a${i}`, i % 2 ? seat(i, 30) : seat(i - 20, -ANIMATION_DISTANCE - 20));
  if (withNearOne) places.set('near', seat(0, 2));
  const manager = new AgentManager(scene, fixedLayout(places) as never);
  for (const id of places.keys()) manager.addAgent({ id, name: id, activity: 'implementing' });
  const renderer = fakeRenderer();
  const loop = new FrameLoop({
    scene,
    camera,
    renderer: renderer as never,
    labelRenderer: { render: () => undefined },
    update: (elapsed, delta) => manager.update(elapsed, delta),
    figures: () => manager.getAgents().map((managed) => managed.figure.group),
    mode: () => 'first-person',
    stats: new FrameStats(),
  });
  const run = (seconds: number) => {
    for (const now of frameTimes(seconds)) loop.frame(now);
  };
  return { manager, renderer, run };
}

test('40 agents and nothing walking: off-screen and far figures sleep, the office is idle and renders once a second', () => {
  const { manager, renderer, run } = crowd(false);
  run(1);
  assert.ok(manager.getAgents().every((managed) => isAnimationAsleep(managed.figure.group)));
  const before = renderer.renders;
  run(5);
  const renders = renderer.renders - before;
  assert.ok(renders <= 6, `${renders} renders in 5 s`);
});

test('a near figure in view keeps its idle sway and the loop keeps rendering for it', () => {
  const { manager, renderer, run } = crowd(true);
  run(2);
  const near = manager.getAgents().find((managed) => managed.info.id === 'near')!;
  assert.equal(isAnimationAsleep(near.figure.group), false);
  assert.equal(manager.getAgents().filter((managed) => !isAnimationAsleep(managed.figure.group)).length, 1);
  assert.ok(renderer.renders >= 55, `${renderer.renders} renders in 2 s`);
});
