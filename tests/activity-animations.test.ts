import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { Activity } from '../src/agents/ActivityAnimations.js';

// Toon materials paint a gradient on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { buildSkeleton } = await import('../src/characters/StickFigureParts.js');
const { animateActivity, animateWalking } = await import('../src/agents/ActivityAnimations.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const FRAME = 1 / 60;
const SETTLE_SECONDS = 3;

function hold(joints: ReturnType<typeof buildSkeleton>, activity: Activity, from: number, seconds: number, raiseHand = false): number {
  let t = from;
  const until = from + seconds;
  for (; t < until; t += FRAME) animateActivity(joints, activity, t, FRAME, undefined, raiseHand);
  return t;
}

/** #163: once settled, a still pose must not keep moving — a later sample must equal an earlier one. */
function assertHoldsStill(activity: Activity, raiseHand = false): void {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  const t = hold(joints, activity, 0, SETTLE_SECONDS, raiseHand);
  const bodyZ = joints.body.rotation.z;
  const neckZ = joints.neck.rotation.z;
  hold(joints, activity, t, 1, raiseHand);
  assert.equal(joints.body.rotation.z, bodyZ, `${activity}: body.rotation.z still moves a second later`);
  assert.equal(joints.neck.rotation.z, neckZ, `${activity}: neck.rotation.z still moves a second later`);
}

test('idle holds still: body and neck stop moving once settled (#163)', () => {
  assertHoldsStill('idle');
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  hold(joints, 'idle', 0, SETTLE_SECONDS);
  assert.ok(Math.abs(joints.body.rotation.z) < 1e-6, `body.rotation.z settled away from 0: ${joints.body.rotation.z}`);
  assert.ok(Math.abs(joints.neck.rotation.z) < 1e-6, `neck.rotation.z settled away from 0: ${joints.neck.rotation.z}`);
});

test('testing, debugging, deploying and meeting hold still too: the matching sway is gone (#163)', () => {
  assertHoldsStill('testing');
  assertHoldsStill('debugging');
  assertHoldsStill('deploying');
  assertHoldsStill('meeting');
});

test('implementing, researching, reviewing and writing docs already held still, still do (regression)', () => {
  // Not 'planning': it keeps its own small neck sway (Math.sin), out of #163's scope
  // (the issue lists idle, testing, debugging, deploying and meeting only).
  assertHoldsStill('implementing');
  assertHoldsStill('researching');
  assertHoldsStill('reviewing');
  assertHoldsStill('writing_docs');
});

test('the raised hand still waves on top of an otherwise still idle pose (#163 keeps this)', () => {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  const t = hold(joints, 'idle', 0, SETTLE_SECONDS, true);
  const armZAtT = joints.rightUpperArm.rotation.z;
  hold(joints, 'idle', t, 0.2, true);
  assert.notEqual(joints.rightUpperArm.rotation.z, armZAtT, 'the wave (Math.sin in animateRaisedHand) must keep moving');
});

test('meeting still turns its head while gesturing (the primary motion, not sway)', () => {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  const samples = new Set<number>();
  let t = 0;
  for (let i = 0; i < 180; i++) {
    animateActivity(joints, 'meeting', t, FRAME);
    samples.add(Math.round(joints.neck.rotation.y * 1000));
    t += FRAME;
  }
  assert.ok(samples.size > 10, `neck.rotation.y (head turn) should keep changing while gesturing, got ${samples.size} distinct samples`);
});

test('deploying still jumps (the primary celebration motion, not sway)', () => {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  const heights = new Set<number>();
  let t = 0;
  for (let i = 0; i < 120; i++) {
    animateActivity(joints, 'deploying', t, FRAME);
    heights.add(Math.round(joints.hips.position.y * 1000));
    t += FRAME;
  }
  assert.ok(heights.size > 10, `the jump (hips.position.y) should keep changing, got ${heights.size} distinct samples`);
});

test('walking still walks: legs and arms keep swinging (unaffected by #163)', () => {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  const legAngles = new Set<number>();
  let t = 0;
  for (let i = 0; i < 120; i++) {
    animateWalking(joints, t, FRAME);
    legAngles.add(Math.round(joints.leftUpperLeg.rotation.x * 1000));
    t += FRAME;
  }
  assert.ok(legAngles.size > 10, `the walk cycle should keep changing, got ${legAngles.size} distinct samples`);
});
