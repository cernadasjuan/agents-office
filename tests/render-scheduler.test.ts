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
const { RenderScheduler, renderQuality, renderOnScreenLabels, isDebugMode, FrameStats } = await import('../src/scene/RenderScheduler.js');
const { FrameLoop } = await import('../src/scene/FrameLoop.js');
const { StickFigure } = await import('../src/characters/StickFigure.js');
const { addLighting } = await import('../src/scene/SceneSetup.js');
const { CSS2DObject } = await import('three/addons/renderers/CSS2DRenderer.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const DISPLAY_HZ = 60;
const frameTimes = (seconds: number, hz = DISPLAY_HZ) => Array.from({ length: seconds * hz }, (_, i) => (i * 1000) / hz);

test('the logic runs at most 30 times a second on a 60 Hz and a 120 Hz display', () => {
  for (const hz of [60, 120]) {
    const scheduler = new RenderScheduler();
    const ticks = frameTimes(2, hz).filter((now) => scheduler.shouldTick(now)).length;
    assert.ok(ticks >= 58 && ticks <= 60, `${ticks} ticks in 2 s at ${hz} Hz`);
  }
});

test('nothing moves: one render on start, then one per second; a request or motion renders at once', () => {
  const scheduler = new RenderScheduler();
  const renders = [0, 100, 500, 999, 1000, 1500, 2000].filter((now) => scheduler.shouldRender(now, false));
  assert.deepEqual(renders, [0, 1000, 2000]);
  scheduler.request();
  assert.equal(scheduler.shouldRender(2100, false), true);
  assert.equal(scheduler.shouldRender(2133, true), true);
});

test('the isometric view uses at most 1.5 pixels per CSS pixel and hard shadows; first person keeps the look', () => {
  assert.deepEqual(renderQuality('isometric', 2), { pixelRatio: 1.5, shadowType: THREE.BasicShadowMap });
  assert.deepEqual(renderQuality('isometric', 1), { pixelRatio: 1, shadowType: THREE.BasicShadowMap });
  assert.deepEqual(renderQuality('first-person', 3), { pixelRatio: 2, shadowType: THREE.PCFShadowMap });
});

test('only labels on screen go to the label renderer; the others keep their own visibility', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld();
  const label = (x: number, z: number) => {
    const object = new CSS2DObject(document.createElement('div'));
    object.position.set(x, 0, z);
    scene.add(object);
    return object;
  };
  const front = label(0, 0);
  const aside = label(60, 0);
  const behind = label(0, 20);
  const off = label(1, 0);
  off.visible = false;
  scene.updateMatrixWorld();

  let seen: boolean[] = [];
  const onScreen = renderOnScreenLabels(scene, camera, () => {
    seen = [front, aside, behind, off].map((object) => object.visible);
  });

  assert.equal(onScreen, 1);
  assert.deepEqual(seen, [true, false, false, false]);
  assert.deepEqual([front, aside, behind, off].map((object) => object.visible), [true, true, true, false]);
});

test('?debug=1 turns on the stats read', () => {
  assert.equal(isDebugMode('?debug=1'), true);
  assert.equal(isDebugMode('?layout=activity'), false);
});

interface FakeRenderer {
  renders: number;
  shadowUpdates: number;
  pixelRatio: number;
  render(): void;
  info: { render: { calls: number; triangles: number }; autoReset: boolean; resets: number; reset(): void };
  domElement: EventTarget;
  shadowMap: { needsUpdate: boolean; type: THREE.ShadowMapType };
  getPixelRatio(): number;
  setPixelRatio(value: number): void;
}

function fakeRenderer(): FakeRenderer {
  const renderer: FakeRenderer = {
    renders: 0,
    shadowUpdates: 0,
    pixelRatio: 2,
    info: { render: { calls: 0, triangles: 0 }, autoReset: true, resets: 0, reset() { renderer.info.resets++; } },
    domElement: new EventTarget(),
    shadowMap: { needsUpdate: false, type: THREE.PCFShadowMap },
    render() {
      // The real renderer resets its info after the shadow pass: the loop must reset it itself
      if (renderer.info.autoReset) renderer.info.reset();
      renderer.renders++;
      if (renderer.shadowMap.needsUpdate) renderer.shadowUpdates++;
      renderer.shadowMap.needsUpdate = false;
    },
    getPixelRatio: () => renderer.pixelRatio,
    setPixelRatio(value: number) {
      renderer.pixelRatio = value;
    },
  };
  return renderer;
}

function officeLoop(options: { animate?: (figure: InstanceType<typeof StickFigure>, elapsed: number) => void; at?: THREE.Vector3 } = {}) {
  const scene = new THREE.Scene();
  addLighting(scene);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(-12, 5.5, 11);
  const figure = new StickFigure('agent', new THREE.Color(0xe05050));
  figure.group.position.copy(options.at ?? new THREE.Vector3(0, 0, 0));
  scene.add(figure.group);
  const renderer = fakeRenderer();
  const stats = new FrameStats();
  let mode: 'first-person' | 'isometric' = 'first-person';
  const loop = new FrameLoop({
    scene,
    camera,
    renderer: renderer as never,
    labelRenderer: { render: () => undefined },
    update: (elapsed) => options.animate?.(figure, elapsed),
    figures: () => [figure.group],
    mode: () => mode,
    devicePixelRatio: () => 2,
    stats,
  });
  const run = (seconds: number, from = 0) => {
    for (const now of frameTimes(seconds)) loop.frame(from + now);
  };
  return { scene, loop, renderer, stats, run, setMode: (next: typeof mode) => { mode = next; } };
}

test('an idle office renders once a second and never redraws its shadow maps after the first frame', () => {
  const { renderer, run } = officeLoop();
  run(5);
  assert.ok(renderer.renders >= 5 && renderer.renders <= 6, `${renderer.renders} renders in 5 s`);
  assert.equal(renderer.shadowUpdates, 1);
});

test('a figure that only sways under the hall lamps renders at 30 fps but redraws the shadows at most twice a second', () => {
  const { renderer, run } = officeLoop({ animate: (figure, elapsed) => { figure.joints.rightUpperArm.rotation.x = Math.sin(elapsed * 8); } });
  run(10);
  assert.ok(renderer.renders >= 295 && renderer.renders <= 300, `${renderer.renders} renders in 10 s`);
  // The first frame, then at most 2 a second
  assert.ok(renderer.shadowUpdates <= 21, `${renderer.shadowUpdates} shadow updates in 10 s`);
  assert.ok(renderer.shadowUpdates >= 15, `the sway still shows in the shadows: ${renderer.shadowUpdates}`);
});

test('a figure that walks under the hall lamps redraws the shadows on every frame', () => {
  const { renderer, run } = officeLoop({ animate: (figure, elapsed) => { figure.group.position.x = -2 + elapsed; } });
  run(2);
  assert.ok(renderer.shadowUpdates >= 58, `${renderer.shadowUpdates} shadow updates in 2 s`);
});

test('a figure that turns on the spot under the hall lamps redraws the shadows on every frame', () => {
  const { renderer, run } = officeLoop({ animate: (figure, elapsed) => { figure.group.rotation.y = elapsed; } });
  run(2);
  assert.ok(renderer.shadowUpdates >= 58, `${renderer.shadowUpdates} shadow updates in 2 s`);
});

test('after a WebGL context restore the next frame renders and redraws the shadow maps', () => {
  const { renderer, run } = officeLoop();
  run(2);
  const renders = renderer.renders;
  const shadows = renderer.shadowUpdates;
  renderer.domElement.dispatchEvent(new Event('webglcontextrestored'));
  run(0.1, 2000);
  assert.equal(renderer.renders, renders + 1);
  assert.equal(renderer.shadowUpdates, shadows + 1);
});

test('the stats count the shadow pass too: the loop resets the renderer info before each render, not after the shadows', () => {
  const { renderer, run } = officeLoop();
  run(2);
  assert.equal(renderer.info.autoReset, false);
  assert.equal(renderer.info.resets, renderer.renders);
});

test('a figure moving in a far room renders but leaves the hall shadow maps alone', () => {
  const { renderer, run } = officeLoop({
    at: new THREE.Vector3(40, 0, 0),
    animate: (figure, elapsed) => { figure.joints.rightUpperArm.rotation.x = Math.sin(elapsed * 8); },
  });
  run(2);
  assert.ok(renderer.renders >= 58, `${renderer.renders} renders`);
  assert.equal(renderer.shadowUpdates, 1);
});

test('switching to the isometric view lowers the pixel ratio, turns soft shadows off and redraws them once', () => {
  const { renderer, run, setMode } = officeLoop();
  run(1);
  assert.equal(renderer.pixelRatio, 2);
  setMode('isometric');
  const before = renderer.shadowUpdates;
  run(1, 1000);
  assert.equal(renderer.pixelRatio, 1.5);
  assert.equal(renderer.shadowMap.type, THREE.BasicShadowMap);
  assert.equal(renderer.shadowUpdates, before + 1);
});

test('a scene change asks for a frame, and new shadow casters redraw the shadows', () => {
  const { scene, loop, renderer, run } = officeLoop();
  run(1);
  const renders = renderer.renders;
  const shadows = renderer.shadowUpdates;
  const board = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.1), new THREE.MeshBasicMaterial());
  board.castShadow = true;
  scene.add(board);
  loop.sceneChanged();
  loop.frame(1100);
  assert.equal(renderer.renders, renders + 1);
  assert.equal(renderer.shadowUpdates, shadows + 1);
});
