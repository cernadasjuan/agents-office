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
const { HIP_HEIGHT } = await import('../src/characters/StickFigureParts.js');
const { SEATED_HIP_HEIGHT } = await import('../src/agents/ActivityAnimations.js');
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

  // The first asleep tick settles the pose once; after that the sway stops
  manager.update(31 / 30, 1 / 30);
  const awakeBefore = rotations(awake.figure.group);
  const asleepBefore = rotations(asleep.figure.group);
  for (let i = 32; i <= 60; i++) manager.update(i / 30, 1 / 30);
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

/** One agent at a desk seat that sleeps from its very first tick. */
function sleeper(activity: 'implementing' | 'idle' = 'implementing') {
  const places = new Map([['far', seat(0, 0)]]);
  const manager = new AgentManager(new THREE.Scene(), fixedLayout(places) as never);
  manager.addAgent({ id: 'far', name: 'far', activity });
  const [managed] = manager.getAgents();
  setAnimationAsleep(managed.figure.group, true);
  let tick = 0;
  const run = (ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      tick++;
      manager.update(tick / 30, 1 / 30);
    }
  };
  return { manager, managed, places, run };
}

// Issue #165's Hero body shortened the legs, moving these off the pre-Hero 0.5/0.9.
// Round 7 re-tuned the seated drop so hips land on the seat, not below it
// (ActivityAnimations.ts's SEATED_HIP_HEIGHT) — read the real constant, not a second
// hardcoded copy of it.
const SEATED_HIPS = SEATED_HIP_HEIGHT;
const STANDING_HIPS = HIP_HEIGHT;
const RAISED_ARM = -2.9;

test('a figure asleep from its first frame shows its activity pose, not the rest pose', () => {
  const { managed, run } = sleeper('implementing');
  run(1);
  assert.ok(Math.abs(managed.figure.joints.hips.position.y - SEATED_HIPS) < 0.01, `hips at ${managed.figure.joints.hips.position.y}`);
  assert.ok(managed.figure.joints.leftUpperArm.rotation.x < -0.9, 'the hands reach the keyboard');
});

test('an activity or attention change on a sleeping figure shows the new pose within one tick, raised hand included', () => {
  const { manager, managed, run } = sleeper('implementing');
  run(5);
  manager.setActivity('far', 'idle');
  run(1);
  assert.ok(Math.abs(managed.figure.joints.hips.position.y - STANDING_HIPS) < 0.01, `stands up: hips at ${managed.figure.joints.hips.position.y}`);

  manager.setExtras('far', { attention: 'waiting', waitMinutes: 3 });
  run(1);
  assert.ok(Math.abs(managed.figure.joints.rightUpperArm.rotation.x - RAISED_ARM) < 0.05, `raises the hand: ${managed.figure.joints.rightUpperArm.rotation.x}`);

  // Settled: no more sway while it sleeps
  const settled = rotations(managed.figure.group);
  run(30);
  assert.deepEqual(rotations(managed.figure.group), settled);
});

test('a walk that ends while asleep finishes: the figure arrives, stops walking and faces its station', () => {
  const { manager, managed, places, run } = sleeper('implementing');
  run(1);
  places.set('far', { key: 'new', position: new THREE.Vector3(4, 0, 0), lookAt: new THREE.Vector3(4, 0, 5) });
  manager.setActivity('far', 'testing');
  run(30 * 10);
  assert.equal(managed.figure.walking, false);
  assert.ok(managed.figure.group.position.distanceTo(new THREE.Vector3(4, 0, 0)) < 1e-6);
  assert.ok(Math.abs(managed.figure.group.rotation.y - 0) < 1e-6, `faces +z: ${managed.figure.group.rotation.y}`);
  assert.ok(Math.abs(managed.figure.joints.leftUpperLeg.rotation.x) < 0.3, `legs out of the stride: ${managed.figure.joints.leftUpperLeg.rotation.x}`);
});

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

test('a sleeping figure that stays in place still raises its hand when it starts waiting', () => {
  // The layout seats the agent once and keeps it there, so no walk can settle the pose.
  const placeOnce = { seatFor: (_info: unknown, previous: unknown) => (previous === null ? seat(0, 0) : null), release: () => undefined };
  const manager = new AgentManager(new THREE.Scene(), placeOnce as never);
  manager.addAgent({ id: 'far', name: 'far', activity: 'implementing' });
  const [managed] = manager.getAgents();
  setAnimationAsleep(managed.figure.group, true);
  for (let tick = 1; tick <= 5; tick++) manager.update(tick / 30, 1 / 30);

  manager.setExtras('far', { attention: 'waiting', waitMinutes: 3 });
  manager.update(6 / 30, 1 / 30);

  assert.equal(managed.figure.walking, false, 'no walk happened');
  assert.ok(Math.abs(managed.figure.joints.rightUpperArm.rotation.x - RAISED_ARM) < 0.05, `raises the hand: ${managed.figure.joints.rightUpperArm.rotation.x}`);
});
