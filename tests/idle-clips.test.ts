import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { Activity } from '../src/agents/ActivityAnimations.js';
import type { Station } from '../src/scene/Office.js';

// Toon materials paint a gradient on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { buildSkeleton } = await import('../src/characters/StickFigureParts.js');
const { animateActivity } = await import('../src/agents/ActivityAnimations.js');
const { AgentManager } = await import('../src/agents/AgentManager.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const FRAME = 1 / 60;

/**
 * #164: idle agents occasionally play a short canned clip instead of the
 * continuous sway #163 removed. Each figure's own skeleton seeds when it
 * plays (so a room never moves in lockstep) and which clip it draws.
 */
function hold(joints: ReturnType<typeof buildSkeleton>, activity: Activity, from: number, seconds: number): number {
  let t = from;
  const until = from + seconds;
  for (; t < until; t += FRAME) animateActivity(joints, activity, t, FRAME);
  return t;
}

test('an idle figure holds its base pose for a good while before any clip plays', () => {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  hold(joints, 'idle', 0, 40);
  // The base held pose: holding a coffee cup, arm bent, neck level.
  assert.ok(Math.abs(joints.rightUpperArm.rotation.x - -1.2) < 0.05, `still holding the cup: ${joints.rightUpperArm.rotation.x}`);
  assert.ok(Math.abs(joints.neck.rotation.z) < 0.05, `neck still level: ${joints.neck.rotation.z}`);
});

/**
 * Review fix: the original version of this test set `sawClip` on the very
 * first simulated frame, from the settle-in ease alone (rotation.x starts at
 * 0 and eases toward -1.2 over about 0.4s) — no scheduled clip could start
 * that early, so the assertion passed even with the clip feature removed
 * entirely. This version fixes the figure's uuid (so the schedule is
 * reproducible), settles fully first without checking, asserts the held
 * pose stays exactly put through the whole gap the config guarantees (up to
 * `minGap`, 45s), and only then watches for the first real deviation.
 */
function isHeldPose(joints: ReturnType<typeof buildSkeleton>): boolean {
  return Math.abs(joints.rightUpperArm.rotation.x - -1.2) < 0.05 && Math.abs(joints.neck.rotation.z) < 0.05;
}

test('an idle figure eventually plays a clip, then returns to the held base pose', () => {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  joints.root.uuid = 'fixture-idle-clip-1';

  // Settle fully first (not checked): the ease-in from rest must never read as a clip.
  let t = hold(joints, 'idle', 0, 3);
  assert.ok(isHeldPose(joints), 'not yet settled on the held pose after 3s');

  // The config guarantees at least 45s (minGap) before any clip can start: no deviation here.
  t = hold(joints, 'idle', t, 44 - 3);
  assert.ok(isHeldPose(joints), 'a clip started before the configured minimum gap');

  // Watch for the first real deviation, stopping the instant it appears.
  let sawClip = false;
  for (; t < 150; t += FRAME) {
    animateActivity(joints, 'idle', t, FRAME);
    if (!isHeldPose(joints)) { sawClip = true; break; }
  }
  assert.ok(sawClip, 'no clip played by 150 simulated seconds, for this fixed uuid');

  // The clip lasts at most its configured duration (1.6s); 3 more seconds clears it with
  // margin, and stays well short of the next scheduled clip (at least 45s further out).
  t = hold(joints, 'idle', t, 3);
  assert.ok(isHeldPose(joints), `back on the held pose: rightUpperArm.x=${joints.rightUpperArm.rotation.x}, neck.z=${joints.neck.rotation.z}`);
});

test('two idle figures with different skeletons (so different seeds) do not start their first clip at the same instant', () => {
  const a = buildSkeleton(new THREE.Color(0x4a90d9));
  const b = buildSkeleton(new THREE.Color(0xe08a3c));
  // Fixed, distinct uuids: a real THREE uuid is random per run, which could coincidentally
  // draw the same gap for both figures and make this assertion flaky (review fix spirit).
  a.root.uuid = 'fixture-lockstep-a';
  b.root.uuid = 'fixture-lockstep-b';
  let startA = -1;
  let startB = -1;
  const held = () => ({
    a: Math.abs(a.rightUpperArm.rotation.x - -1.2) < 0.05 && Math.abs(a.neck.rotation.z) < 0.05,
    b: Math.abs(b.rightUpperArm.rotation.x - -1.2) < 0.05 && Math.abs(b.neck.rotation.z) < 0.05,
  });
  // The first ~2 frames can read as "not yet held" purely from the initial ease-in; skip those.
  for (let t = 0; t < 150; t += FRAME) {
    animateActivity(a, 'idle', t, FRAME);
    animateActivity(b, 'idle', t, FRAME);
    if (t < 1) continue;
    const state = held();
    if (startA < 0 && !state.a) startA = t;
    if (startB < 0 && !state.b) startB = t;
  }
  assert.ok(startA >= 0 && startB >= 0, 'both figures should have played a clip by 150s');
  assert.notEqual(startA.toFixed(2), startB.toFixed(2), 'two different figures should not draw the same start time');
});

// --- Review fix 1: a clip never plays on a figure a raised hand or hands-on-hips owns ---

test('a raised hand suppresses the idle clip entirely: the left arm and neck never leave their resting values', () => {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  joints.root.uuid = 'fixture-2'; // draws the stretch clip first, which moves the left arm and neck
  let t = 0;
  // Run well past several clip windows (minGap 45s, up to 90s apart): with the fix, none ever play.
  for (; t < 200; t += FRAME) animateActivity(joints, 'idle', t, FRAME, undefined, true);
  assert.ok(Math.abs(joints.leftUpperArm.rotation.x - 0.1) < 0.05, `left arm strayed from rest: ${joints.leftUpperArm.rotation.x}`);
  assert.ok(Math.abs(joints.neck.rotation.z) < 0.05, `neck strayed from rest: ${joints.neck.rotation.z}`);
  // The right arm is the raised-hand's own: it is expected to be up, not at the held pose.
  assert.ok(joints.rightUpperArm.rotation.x < -2.5, 'the raised hand itself still works');
});

test('hands-on-hips suppresses the idle clip entirely: both arms stay on the hips pose, never a clip target', () => {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  joints.root.uuid = 'fixture-2';
  let t = 0;
  for (; t < 200; t += FRAME) animateActivity(joints, 'idle', t, FRAME, undefined, false, true);
  // The hands-on-hips pose (`animateHandsOnHips`), the same bilateral fold the existing
  // orchestrating test in activity-animations.test.ts checks: never the stretch clip's -2.6.
  assert.ok(joints.leftUpperArm.rotation.x > -1, `left arm reached a clip angle: ${joints.leftUpperArm.rotation.x}`);
  assert.ok(joints.rightUpperArm.rotation.x > -1, `right arm reached a clip angle: ${joints.rightUpperArm.rotation.x}`);
  assert.ok(joints.leftUpperArm.rotation.z > 0.1, 'left arm folds in toward the hip, same direction as the orchestrating test');
  assert.ok(joints.rightUpperArm.rotation.z < -0.1, 'right arm folds in toward the hip, same direction as the orchestrating test');
});

// --- Review fix 3: a clip owns its joints while it plays; the base pose does not fight it ---

test('the stretch clip reaches its own target, not a compromise with the held pose fighting it', () => {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  // This fixed uuid draws the stretch clip (the one that moves the left arm) first, starting
  // at t=59.41 by the same formula `occasionalVariant` uses (minGap 45 + a seeded fraction of
  // the 45s span). Stop well before that so the unconditional settle-in never runs past it.
  joints.root.uuid = 'fixture-2';
  let t = hold(joints, 'idle', 0, 55);
  assert.ok(Math.abs(joints.leftUpperArm.rotation.x - 0.1) < 0.05, 'still on the held pose before the clip starts');

  // Run until the stretch clip visibly starts (left arm leaves its resting 0.1), then
  // check it reaches close to -2.6, not a halfway point a fighting base pose would leave it at.
  for (; t < 65; t += FRAME) {
    animateActivity(joints, 'idle', t, FRAME);
    if (joints.leftUpperArm.rotation.x < -2.4) break;
  }
  assert.ok(joints.leftUpperArm.rotation.x < -2.4, `the stretch never got close to its target: ${joints.leftUpperArm.rotation.x}`);
});

test('testing occasionally prays instead of watching with crossed arms, Gabriel\'s favorite new one', () => {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  let sawPraying = false;
  for (let t = 0; t < 150; t += FRAME) {
    animateActivity(joints, 'testing', t, FRAME);
    // Praying angles the arms in toward each other; the crossed-arms base keeps them apart (z = +/-0.5).
    if (t > 1 && joints.leftUpperArm.rotation.z < 0.45 && joints.rightUpperArm.rotation.z > -0.45) sawPraying = true;
  }
  assert.ok(sawPraying, 'testing never showed the praying variant in 150 simulated seconds');
});

test('planning occasionally sketches on a notepad instead of writing on the whiteboard', () => {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  let sawDrawing = false;
  for (let t = 0; t < 150; t += FRAME) {
    animateActivity(joints, 'planning', t, FRAME);
    // Drawing holds the left arm closer to the body than the whiteboard base ever does (base stays near -0.3).
    if (t > 1 && joints.leftUpperArm.rotation.x < -0.45) sawDrawing = true;
  }
  assert.ok(sawDrawing, 'planning never showed the drawing variant in 150 simulated seconds');
});

// --- Standing-without-a-seat (#164 point 3): an overflow idle figure reads the same as a seated one ---

function idleOnlyOffice(idleSeats: number): Map<string, Station> {
  const stations = new Map<string, Station>();
  for (let i = 0; i < idleSeats; i++) {
    stations.set(`coffee_${i}`, {
      type: 'idle',
      position: new THREE.Vector3(i * 2, 0, 0),
      lookAt: new THREE.Vector3(i * 2, 1, -1),
      occupied: false,
    });
  }
  return stations;
}

test('an idle agent beyond the idle-seat count stands on overflow, not seated, but still plays the same idle pose family', () => {
  const manager = new AgentManager(new THREE.Scene(), idleOnlyOffice(1));
  manager.addAgent({ id: 'seated', name: 'Seated', activity: 'idle' });
  manager.addAgent({ id: 'overflow', name: 'Overflow', activity: 'idle' });

  const [seated, overflow] = manager.getAgents();
  assert.notEqual(
    JSON.stringify([seated.figure.group.position.x, seated.figure.group.position.z]),
    JSON.stringify([overflow.figure.group.position.x, overflow.figure.group.position.z]),
    'the two idle agents must not share a position',
  );

  for (let i = 1; i <= 60; i++) manager.update(i / 60, 1 / 60);
  // Both run through the same animateIdle: the held pose (holding a coffee cup), not two different looks.
  assert.ok(Math.abs(seated.figure.joints.rightUpperArm.rotation.x - -1.2) < 0.05, 'seated idle holds the cup');
  assert.ok(Math.abs(overflow.figure.joints.rightUpperArm.rotation.x - -1.2) < 0.05, 'overflow idle holds the cup too, not a bare stare');
});
