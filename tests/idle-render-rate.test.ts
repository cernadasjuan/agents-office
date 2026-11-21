import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// Toon materials paint a gradient on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { StickFigure } = await import('../src/characters/StickFigure.js');
const { FrameLoop } = await import('../src/scene/FrameLoop.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

/**
 * #163: Gabriel finds 12 swaying idle agents in front of his desk odd, and
 * the continuous sway was costing CPU: it kept every idle figure's instance
 * matrix changing every frame, so FigureBatch.sync() always reported a move,
 * FrameLoop's `active` flag never went false, and the renderer never backed
 * off to RenderScheduler's once-a-second idle cadence (src/scene/FrameLoop.ts).
 * Once a pose settles with no sway left, the office should render on demand
 * like any other still scene.
 */
test('12 idle figures, once settled, stop forcing a render every frame: the loop backs off to about once a second', () => {
  const scene = new THREE.Scene();
  const figures: InstanceType<typeof StickFigure>[] = [];
  for (let i = 0; i < 12; i++) {
    const figure = new StickFigure(`agent${i}`, new THREE.Color(0x4a90d9));
    figure.setActivity('idle');
    figure.group.position.set(i * 0.8, 0, 0);
    scene.add(figure.group);
    figures.push(figure);
  }
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(4, 2, 8);
  camera.lookAt(4, 1, 0);

  let renders = 0;
  const renderer = {
    render: () => { renders++; }, info: { render: { calls: 0, triangles: 0 }, reset: () => undefined },
    shadowMap: { needsUpdate: false, type: THREE.PCFSoftShadowMap }, getPixelRatio: () => 1, setPixelRatio: () => undefined,
  };
  const loop = new FrameLoop({
    scene, camera, renderer: renderer as never, labelRenderer: { render: () => undefined },
    update: (elapsed, delta) => { for (const figure of figures) figure.update(elapsed, delta); },
    figures: () => figures.map((figure) => figure.group), mode: () => 'first-person',
  });

  // Let the pose settle (the ease-to-target transition and any convergence).
  for (let t = 0; t <= 3000; t += 16) loop.frame(t);

  // Over the next 3 simulated seconds, nothing else changes: camera still, no
  // input, no walk. A settled idle pose (no sway) should render at most a
  // few times (RenderScheduler's idle cadence, 1000 ms), not once per frame.
  const before = renders;
  for (let t = 3016; t <= 6000; t += 16) loop.frame(t);
  const rendersWhileIdle = renders - before;

  console.log(`renders over 3 idle seconds: ${rendersWhileIdle} (1 per 16 ms would be ~188)`);
  assert.ok(rendersWhileIdle <= 5, `expected about one render a second once settled, got ${rendersWhileIdle}`);
});

/**
 * #164: the occasional NPC-style idle clip (ActivityAnimations.ts) forces a
 * render only while one figure's clip plays (a few seconds, rare, seeded per
 * figure). Over a long enough run to cover several clips across all 12
 * figures, the *average* render rate must stay close to the no-clip idle
 * cadence above, not drift back toward the old every-frame sway.
 */
test('12 idle figures over 3 minutes (clips included): average renders per 3 s stays low, not back to every-frame', () => {
  const scene = new THREE.Scene();
  const figures: InstanceType<typeof StickFigure>[] = [];
  for (let i = 0; i < 12; i++) {
    const figure = new StickFigure(`agent${i}`, new THREE.Color(0x4a90d9));
    figure.setActivity('idle');
    figure.group.position.set(i * 0.8, 0, 0);
    scene.add(figure.group);
    figures.push(figure);
  }
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(4, 2, 8);
  camera.lookAt(4, 1, 0);

  let renders = 0;
  const renderer = {
    render: () => { renders++; }, info: { render: { calls: 0, triangles: 0 }, reset: () => undefined },
    shadowMap: { needsUpdate: false, type: THREE.PCFSoftShadowMap }, getPixelRatio: () => 1, setPixelRatio: () => undefined,
  };
  const loop = new FrameLoop({
    scene, camera, renderer: renderer as never, labelRenderer: { render: () => undefined },
    update: (elapsed, delta) => { for (const figure of figures) figure.update(elapsed, delta); },
    figures: () => figures.map((figure) => figure.group), mode: () => 'first-person',
  });

  const TOTAL_MS = 180_000; // 3 simulated minutes: several clip cycles per figure (minGap 45s)
  for (let t = 0; t <= TOTAL_MS; t += 16) loop.frame(t);

  const perThreeSeconds = (renders / TOTAL_MS) * 3000;
  console.log(`renders over 180 idle seconds with clips: ${renders}, average per 3 s: ${perThreeSeconds.toFixed(2)}`);
  // Bound: a clip forces a full-rate render while it plays and eases back (a few
  // hundred ms beyond its nominal duration), so the average sits well above the
  // no-clip cadence above (about 3 per 3 s) — measured 25-35 per 3 s across runs,
  // seed-dependent. Still far below the pre-#163 every-frame cost (~188 per 3 s):
  // about an 80%+ cut, with the office never fully quiet, by design (#164).
  assert.ok(perThreeSeconds <= 45, `expected the clip overhead to stay well below the old every-frame cost, got ${perThreeSeconds.toFixed(2)} renders per 3 s`);
});
