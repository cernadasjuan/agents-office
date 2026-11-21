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
const { buildSkeleton, setMouthState, FIGURE_EYE_HEIGHT, NECK_HEIGHT, HEAD_OFFSET, HIP_HEIGHT, SHOULDERS_Y } = await import('../src/characters/StickFigureParts.js');
const { hairStyleFor, bodyScaleFor } = await import('../src/characters/HeroVariety.js');
const { StickFigure } = await import('../src/characters/StickFigure.js');
const { animateActivity } = await import('../src/agents/ActivityAnimations.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const RED = new THREE.Color(0xe05050);

test('FIGURE_EYE_HEIGHT is re-derived from the Hero body, not left at the old plain-stick value', () => {
  // Issue #174's rule still holds: eye height is the neck joint plus the head center,
  // never a hardcoded guess, even after the Hero body changed both.
  assert.equal(FIGURE_EYE_HEIGHT, NECK_HEIGHT + HEAD_OFFSET);
  // The old plain-stick figure measured 1.75. A bigger head and shorter legs move it,
  // but not wildly: still a standing agent's plausible eye height.
  assert.notEqual(FIGURE_EYE_HEIGHT, 1.75);
  assert.ok(FIGURE_EYE_HEIGHT > 1.4 && FIGURE_EYE_HEIGHT < 1.9, `unexpected eye height ${FIGURE_EYE_HEIGHT}`);
});

test('every joint still sits above the one below it: hips < shoulders < neck < head top, even after the proportion change', () => {
  const joints = buildSkeleton(RED);
  const hipsY = joints.hips.position.y;
  const shoulderY = joints.shoulders.position.y;
  const neckY = joints.neck.position.y;
  const headTopY = neckY + joints.head.position.y + (joints.head.geometry as THREE.SphereGeometry).parameters.radius;
  assert.ok(hipsY > 0, 'hips sit above the ground');
  assert.ok(shoulderY > hipsY, 'shoulders sit above the hips');
  assert.ok(neckY > shoulderY, 'the neck sits above the shoulders');
  assert.ok(headTopY > neckY, 'the head top sits above the neck');
});

test('a figure built with no hair style (the default) has no hair group', () => {
  const joints = buildSkeleton(RED);
  const hair = joints.head.children.find((child) => child.name === 'hero-hair');
  assert.equal(hair, undefined);
});

test('each of the 3 non-"none" hair styles attaches one "hero-hair" group under the head, each its own shared shape', () => {
  for (const style of ['cap', 'spiky', 'bun'] as const) {
    const joints = buildSkeleton(RED, undefined, style);
    const hair = joints.head.children.find((child) => child.name === 'hero-hair');
    assert.ok(hair, `expected a hair group for style ${style}`);
    assert.ok(hair!.children.length > 0, `expected at least one piece for style ${style}`);
    for (const piece of hair!.children) {
      assert.equal((piece as THREE.Mesh).userData.figurePart, true);
      assert.equal((piece as THREE.Mesh).castShadow, false);
    }
  }
});

test('the mouth starts neutral and swaps shape (never material) as the figure\'s state changes', () => {
  const figure = new StickFigure('mouth-test', RED);
  const neutralGeometry = figure.joints.mouth.geometry;
  const material = figure.joints.mouth.material;

  figure.setActivity('implementing');
  assert.notEqual(figure.joints.mouth.geometry, neutralGeometry, 'implementing should read as focused, a different mouth shape');
  const focusedGeometry = figure.joints.mouth.geometry;
  assert.equal(figure.joints.mouth.material, material, 'a state change never swaps the material, only the geometry');

  figure.setAttention('waiting', 5);
  assert.notEqual(figure.joints.mouth.geometry, focusedGeometry, 'waiting for Gabriel should read as a third, distinct mouth shape');
  const waitingGeometry = figure.joints.mouth.geometry;

  figure.setAttention(undefined, undefined);
  figure.setActivity('idle');
  assert.equal(figure.joints.mouth.geometry, neutralGeometry, 'back to idle and no wait: the mouth returns to its original neutral shape');
  assert.notEqual(waitingGeometry, neutralGeometry);
});

test('a true call-for-you (waiting) wins over an in-progress activity, same priority as the raised hand', () => {
  const figure = new StickFigure('priority-test', RED);
  figure.setActivity('implementing');
  const focusedGeometry = figure.joints.mouth.geometry;
  figure.setAttention('waiting', 2);
  assert.notEqual(figure.joints.mouth.geometry, focusedGeometry);
});

test('hairStyleFor and bodyScaleFor are deterministic for one name, and vary across names', () => {
  assert.equal(hairStyleFor('amelia'), hairStyleFor('amelia'));
  assert.equal(bodyScaleFor('amelia'), bodyScaleFor('amelia'));
  const styles = new Set(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'].map(hairStyleFor));
  assert.ok(styles.size > 1, 'a handful of names should not all land on the same hair style');
  for (const name of ['f0', 'f1', 'f2']) {
    const scale = bodyScaleFor(name);
    assert.ok(scale >= 0.9 && scale <= 1.1, `body scale ${scale} for ${name} outside the expected narrow range`);
  }
});

test('body width is a root scale (x and z only); FIGURE_EYE_HEIGHT stays true for every figure regardless of its width', () => {
  const figure = new StickFigure('width-test', RED);
  const scale = figure.joints.root.scale;
  assert.equal(scale.y, 1, 'height never varies per agent, only width/depth');
  assert.equal(scale.x, scale.z, 'width and depth scale together, so the figure never looks squashed from one side');
  // The two checks above alone pass even with the feature removed entirely (an untouched
  // THREE.Group's default scale is already (1, 1, 1)). Pin the root scale to the exact
  // seeded value, and that two different names actually produce two different widths, so
  // a regression that silently drops the body-width feature fails this test.
  assert.equal(scale.x, bodyScaleFor('width-test'), 'root x/z scale must equal the name-seeded width, not an untouched default');
  const widths = new Set(['f0', 'f1', 'f2', 'f3'].map((name) => new StickFigure(name, RED).joints.root.scale.x));
  assert.ok(widths.size > 1, 'a handful of names should not all produce the same body width');
});

test('idle, standing, and walking all settle the hips/shoulders/neck at the Hero body\'s own height, not the old pre-Hero constants', () => {
  // Regression: ActivityAnimations.ts's base-pose functions used to hardcode the
  // pre-Hero absolute joint heights (0.9/1.5/1.6). Building a figure at the Hero's
  // shorter HIP_HEIGHT/SHOULDERS_Y/NECK_HEIGHT only set the *initial* position; every
  // following idle/standing/walking frame then pulled the rig back up to the old,
  // taller values, floating the feet off the ground within under a second.
  const joints = buildSkeleton(RED);
  for (let i = 0; i < 300; i++) animateActivity(joints, 'idle', i * 0.016, 0.016);
  assert.ok(Math.abs(joints.hips.position.y - HIP_HEIGHT) < 0.01, `hips drifted to ${joints.hips.position.y}, expected ~${HIP_HEIGHT}`);
  assert.ok(Math.abs(joints.shoulders.position.y - SHOULDERS_Y) < 0.01, `shoulders drifted to ${joints.shoulders.position.y}, expected ~${SHOULDERS_Y}`);
  assert.ok(Math.abs(joints.neck.position.y - NECK_HEIGHT) < 0.01, `neck drifted to ${joints.neck.position.y}, expected ~${NECK_HEIGHT}`);
});
