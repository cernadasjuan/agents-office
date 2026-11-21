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

test('an idle figure eventually plays a clip, then returns to the held base pose', () => {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  let sawClip = false;
  let t = 0;
  // minGap is 45s; run well past the maxGap (90s) to be sure one clip starts.
  for (; t < 150; t += FRAME) {
    animateActivity(joints, 'idle', t, FRAME);
    const holdingCup = Math.abs(joints.rightUpperArm.rotation.x - -1.2) < 0.05 && Math.abs(joints.neck.rotation.z) < 0.05;
    if (!holdingCup) sawClip = true;
  }
  assert.ok(sawClip, 'no clip played in 150 simulated seconds');

  // After the clip ends it settles back to the same held pose, same as #163.
  hold(joints, 'idle', t, 5);
  assert.ok(Math.abs(joints.rightUpperArm.rotation.x - -1.2) < 0.05, `back on the held pose: ${joints.rightUpperArm.rotation.x}`);
  assert.ok(Math.abs(joints.neck.rotation.z) < 0.05, `neck back level: ${joints.neck.rotation.z}`);
});

test('two idle figures with different skeletons (so different seeds) do not start their first clip at the same instant', () => {
  const a = buildSkeleton(new THREE.Color(0x4a90d9));
  const b = buildSkeleton(new THREE.Color(0xe08a3c));
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
