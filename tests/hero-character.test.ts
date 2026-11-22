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
const { buildSkeleton, setMouthState, FIGURE_EYE_HEIGHT, NECK_HEIGHT, HEAD_OFFSET, HIP_HEIGHT, SHOULDERS_Y, LIMB_RADIUS } = await import('../src/characters/StickFigureParts.js');
const { hairStyleFor, bodyScaleFor } = await import('../src/characters/HeroVariety.js');
const { StickFigure } = await import('../src/characters/StickFigure.js');
const { animateActivity, SEATED_HIP_HEIGHT } = await import('../src/agents/ActivityAnimations.js');
const { Colors } = await import('../src/utils/Colors.js');
const { createSofa } = await import('../src/furniture/Sofa.js');
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
  // Round 7 (review: "the lack of neck is kind of disturbing"): the neck joint now sits
  // exactly at the shoulders' own height (NECK_MARGIN removed) — the elongated torso
  // capsule, not a separate gap, is what reaches the head, so this is `>=`, not `>`.
  assert.ok(neckY >= shoulderY, 'the neck sits at or above the shoulders');
  assert.ok(headTopY > neckY, 'the head top sits above the neck');
});

test('a figure built with no hair style (the default) has no hair group', () => {
  const joints = buildSkeleton(RED);
  const hair = joints.head.children.find((child) => child.name === 'hero-hair');
  assert.equal(hair, undefined);
});

test('each of the 3 non-"none" hair styles attaches one "hero-hair" group under the head, each its own shared shape', () => {
  for (const style of ['tufts', 'spiky', 'bun'] as const) {
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

/** A limb joint's one mesh and its *effective* radius: the geometry's own radius times
 * whatever x/z instance scale sits on the mesh (round 7's forearm-thinning trick is a
 * scale, not a smaller geometry, so the raw `geometry.parameters.radiusTop` alone would
 * miss it). */
function limbMesh(limb: THREE.Object3D): { mesh: THREE.Mesh; effectiveRadius: number } {
  const mesh = limb.children.find((child) => child instanceof THREE.Mesh) as THREE.Mesh | undefined;
  assert.ok(mesh, 'every limb joint carries exactly one limb mesh');
  const geometry = mesh!.geometry as THREE.CylinderGeometry;
  return { mesh: mesh!, effectiveRadius: geometry.parameters.radiusTop * mesh!.scale.x };
}

test('issue #165 round 3 (review follow-up): arm and leg limbs are chunky, not the old plain-stick radius, and read as a body tone, not near-black', () => {
  // Pre-this-round, every limb (upper/lower leg, upper arm, forearm) was a 0.035-radius
  // cylinder in a near-black navy (Colors.limb was 0x333344) — thin and dark enough to
  // still read as a wireframe stick next to the Hero body's bigger head/torso/hands.
  const MIN_EFFECTIVE_RADIUS = 0.04; // comfortably above the old 0.035; round 7 thinned legs and forearms, but not back to the old stick
  assert.ok(LIMB_RADIUS >= 0.055, `LIMB_RADIUS ${LIMB_RADIUS} should be at or above the pre-round-7 minimum 0.055`);

  const joints = buildSkeleton(RED);
  for (const limb of [joints.leftUpperLeg, joints.leftLowerLeg, joints.rightUpperLeg, joints.rightLowerLeg,
    joints.leftUpperArm, joints.leftForearm, joints.rightUpperArm, joints.rightForearm]) {
    const { mesh, effectiveRadius } = limbMesh(limb);
    assert.ok(effectiveRadius >= MIN_EFFECTIVE_RADIUS, `effective limb radius ${effectiveRadius} is still at or near the old thin-stick value`);

    const material = mesh.material as THREE.MeshToonMaterial;
    // Compare the sRGB hex channels directly (0-255), not `.color.r/g/b`, which three.js
    // stores color-managed (linear), not the plain hex values this assertion means to
    // read. "Near-black" (the old 0x333344: 51/51/68) is low in every channel; the new
    // skin-adjacent tone must clear it well on every channel, not just brighten one.
    const hex = material.color.getHexString();
    const [r, g, b] = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((part) => parseInt(part, 16));
    assert.ok(r > 150 && g > 120 && b > 100, `limb color (#${hex}) still reads as a dark, near-black stick`);
  }
  // Not literally re-using Colors.skin's own material/bucket (head and hand already own
  // that one): a distinct, but still light, skin-adjacent tone.
  assert.equal(Colors.limb.getHexString(), 'e0b894');
});

test('issue #165 round 7 (review: "their hands and their front arms looks like dicks... make the front part of the forearm thinner"): the forearm is thinner than the upper arm, and shares its bucket with it', () => {
  const joints = buildSkeleton(RED);
  const upperArm = limbMesh(joints.rightUpperArm);
  const forearm = limbMesh(joints.rightForearm);
  assert.ok(forearm.effectiveRadius < upperArm.effectiveRadius, `forearm radius ${forearm.effectiveRadius} should be below the upper arm's ${upperArm.effectiveRadius}`);
  // Thinned by a scale, never a smaller geometry: same shared geometry object as the
  // upper arm, so both still draw in the one 'arm' FigureBatch bucket (issue #167's
  // "draw calls must not grow" constraint).
  assert.equal(forearm.mesh.geometry, upperArm.mesh.geometry, 'the forearm must share the upper arm\'s geometry, never mint a second bucket');
  assert.equal(forearm.mesh.material, upperArm.mesh.material);
});

test('issue #165 round 7 (review: "a little bit thinner legs too"): legs are thinner than arms, still their own dedicated bucket', () => {
  const joints = buildSkeleton(RED);
  const upperArm = limbMesh(joints.rightUpperArm);
  const upperLeg = limbMesh(joints.rightUpperLeg);
  assert.ok(upperLeg.effectiveRadius < upperArm.effectiveRadius, `leg radius ${upperLeg.effectiveRadius} should be below the arm's ${upperArm.effectiveRadius}`);
});

test('issue #165 round 7 (review: a round mitten "really looks like a dick head"): the hand is not a sphere', () => {
  const joints = buildSkeleton(RED);
  assert.notEqual(joints.rightHand.geometry.type, 'SphereGeometry');
  assert.equal(joints.rightHand.geometry.type, 'BoxGeometry');
});

test('issue #165 round 7 (review: "the lack of neck is kind of disturbing"): the torso top meets the head bottom, no gap', () => {
  const joints = buildSkeleton(RED);
  const torsoGeometry = joints.torso.geometry as THREE.CapsuleGeometry;
  const torsoTop = joints.hips.position.y + joints.torso.position.y + (torsoGeometry.parameters.height / 2 + torsoGeometry.parameters.radius);
  const headBottom = joints.neck.position.y + joints.head.position.y - (joints.head.geometry as THREE.SphereGeometry).parameters.radius;
  assert.ok(Math.abs(torsoTop - headBottom) < 0.001, `torso top ${torsoTop} should meet the head bottom ${headBottom}, no gap`);
});

test('issue #165 round 7 (review: "the sub-agents when sitting on a sofa look that they\'re sinking in a sofa"): seated hips land on the sofa\'s own seat top, not below it', () => {
  const sofa = createSofa();
  const seat = sofa.children.find((child) => (child as THREE.Mesh).geometry instanceof THREE.BoxGeometry
    && (child as THREE.Mesh).position.y > 0.3 && (child as THREE.Mesh).position.y < 0.4) as THREE.Mesh;
  assert.ok(seat, 'expected to find the sofa seat cushion mesh');
  const seatGeometry = seat.geometry as THREE.BoxGeometry;
  const seatTop = seat.position.y + seatGeometry.parameters.height / 2;
  // Seated hips should rest at, or a hair above, the seat surface — never noticeably
  // below it (sinking) and never floating far above it either.
  assert.ok(SEATED_HIP_HEIGHT >= seatTop - 0.02 && SEATED_HIP_HEIGHT <= seatTop + 0.05,
    `seated hips at ${SEATED_HIP_HEIGHT} should rest on the sofa's own seat top ${seatTop}, not sink below it`);
});

test('issue #165 round 7 follow-up (review: "the sub-agents... and the agents too"): a 0.85-scaled subagent\'s seated hips still land on the sofa seat top, in world space', () => {
  // AgentManager scales a subagent's whole figure group (`root`) by 0.85, the same
  // group the seated hip/shoulder/neck targets are local to. A fix tuned only against
  // the unscaled (agent) case would still land a subagent's hips below the seat.
  const sofa = createSofa();
  const seat = sofa.children.find((child) => (child as THREE.Mesh).geometry instanceof THREE.BoxGeometry
    && (child as THREE.Mesh).position.y > 0.3 && (child as THREE.Mesh).position.y < 0.4) as THREE.Mesh;
  const seatGeometry = seat.geometry as THREE.BoxGeometry;
  const seatTop = seat.position.y + seatGeometry.parameters.height / 2;

  const joints = buildSkeleton(RED);
  joints.root.scale.setScalar(0.85);
  for (let i = 0; i < 300; i++) animateActivity(joints, 'idle', i * 0.016, 0.016, 'seated');
  const worldHipsY = joints.hips.position.y * joints.root.scale.y;
  assert.ok(worldHipsY >= seatTop - 0.02 && worldHipsY <= seatTop + 0.05,
    `a subagent's world-space seated hips at ${worldHipsY} should rest on the sofa's own seat top ${seatTop}, not sink below it`);
});
