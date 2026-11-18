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

function hold(joints: ReturnType<typeof buildSkeleton>, activity: Activity, seconds: number): void {
  for (let t = 0; t < seconds; t += FRAME) animateActivity(joints, activity, t, FRAME);
}

test('arms spread by one pose return to rest in a pose that does not spread them', () => {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  hold(joints, 'testing', 3);
  hold(joints, 'implementing', 3);

  assert.ok(Math.abs(joints.leftUpperArm.rotation.z) < 0.01, `left arm z ${joints.leftUpperArm.rotation.z}`);
  assert.ok(Math.abs(joints.rightUpperArm.rotation.z) < 0.01, `right arm z ${joints.rightUpperArm.rotation.z}`);
});

test('a head turn from a meeting does not stay in the next pose', () => {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  let t = 0;
  while (Math.abs(joints.neck.rotation.y) < 0.1) { t += FRAME; animateActivity(joints, 'meeting', t, FRAME); }
  hold(joints, 'idle', 3);

  assert.ok(Math.abs(joints.neck.rotation.y) < 0.01, `neck y ${joints.neck.rotation.y}`);
  assert.ok(Math.abs(joints.neck.rotation.x) < 0.01, `neck x ${joints.neck.rotation.x}`);
});

test('walking does not keep the arm spread of the previous pose', () => {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  hold(joints, 'testing', 3);
  for (let t = 0; t < 3; t += FRAME) animateWalking(joints, t, FRAME);

  assert.ok(Math.abs(joints.leftUpperArm.rotation.z) < 0.01, `left arm z ${joints.leftUpperArm.rotation.z}`);
});
