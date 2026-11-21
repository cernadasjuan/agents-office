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
const { formatWait, formatWaitShort } = await import('../src/ui/attention.js');
const { SEATED_HIP_HEIGHT } = await import('../src/agents/ActivityAnimations.js');
// Issue #165's Hero body shortened the legs, moving the seated hip height off the pre-Hero
// 0.5; round 7 re-tuned the seated drop so hips land on the seat, not below it — read the
// real constant (ActivityAnimations.ts), not a second hardcoded copy of it.
const SEATED_HIPS = SEATED_HIP_HEIGHT;
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

function run(figure: InstanceType<typeof StickFigure>, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 60) figure.update(t, 1 / 60);
}

const activityText = (figure: InstanceType<typeof StickFigure>) => figure.label.element.querySelector('.activity')?.textContent;
const waitText = (figure: InstanceType<typeof StickFigure>) => figure.label.element.querySelector('.wait')?.textContent;

test('a waiting agent raises its right hand and keeps the rest of its pose', () => {
  const figure = new StickFigure('agent', new THREE.Color(0x4a90d9));
  figure.setActivity('implementing');
  figure.setAttention('waiting', 12);
  run(figure, 3);

  assert.ok(figure.joints.rightUpperArm.rotation.x < -2.7, `right arm ${figure.joints.rightUpperArm.rotation.x}`);
  assert.ok(Math.abs(figure.joints.hips.position.y - SEATED_HIPS) < 0.02, 'still seated');
  assert.ok(Math.abs(figure.joints.leftForearm.rotation.x + 1.3) < 0.2, 'left hand still types');
  assert.equal(activityText(figure), 'Waiting for you · 12 min');
});

test('the beacon shows only while the agent waits, and the hand comes down after', () => {
  const figure = new StickFigure('agent', new THREE.Color(0x4a90d9));
  figure.setActivity('implementing');
  figure.setAttention('waiting', 1);
  const beacon = figure.group.children.find((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.OctahedronGeometry)!;
  assert.equal(beacon.visible, true);

  figure.setAttention(undefined, undefined);
  run(figure, 3);
  assert.equal(beacon.visible, false);
  assert.ok(figure.joints.rightUpperArm.rotation.x > -1.5, 'hand back on the keyboard');
  assert.equal(activityText(figure), 'Implementing');
});

test('your turn changes the label but raises no hand', () => {
  const figure = new StickFigure('agent', new THREE.Color(0x4a90d9));
  figure.setActivity('idle');
  figure.setAttention('your-turn', 125);
  run(figure, 2);
  assert.equal(activityText(figure), 'Your turn · 2 h');
  assert.ok(figure.joints.rightUpperArm.rotation.x > -2, 'idle coffee arm');
});

test('waits read in minutes, hours, then days', () => {
  assert.deepEqual([formatWait(5), formatWait(59), formatWait(60), formatWait(47 * 60), formatWait(3 * 24 * 60)],
    ['5 min', '59 min', '1 h', '47 h', '3 d']);
});

test('the short wait chip uses the same bands, without the space (#132)', () => {
  assert.deepEqual(
    [formatWaitShort(5), formatWaitShort(59), formatWaitShort(60), formatWaitShort(47 * 60), formatWaitShort(3 * 24 * 60)],
    ['5m', '59m', '1h', '47h', '3d'],
  );
});

test('a waiting agent carries a wait chip, so the time still reads once the label goes compact (#132)', () => {
  const figure = new StickFigure('agent', new THREE.Color(0x4a90d9));
  figure.setActivity('implementing');
  figure.setAttention('waiting', 12);
  run(figure, 3);
  assert.equal(waitText(figure), '12m');

  figure.setAttention(undefined, undefined);
  run(figure, 3);
  assert.equal(waitText(figure), undefined, 'no wait chip once the agent stops waiting');
});

test('the label carries the agent color for the compact dot, and the label keeps its plain class', () => {
  const figure = new StickFigure('agent', new THREE.Color(0x4a90d9));
  assert.equal(figure.label.element.style.getPropertyValue('--agent-color'), '#4a90d9');
  assert.equal(figure.label.element.className, 'agent-label');
});

const beaconOf = (figure: InstanceType<typeof StickFigure>) =>
  figure.group.children.find((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.OctahedronGeometry);

test('a fresh your-turn wait raises the hand and shows the beacon', () => {
  const figure = new StickFigure('agent', new THREE.Color(0x4a90d9));
  figure.setActivity('idle');
  figure.setAttention('your-turn', 4);
  run(figure, 3);
  assert.equal(beaconOf(figure)?.visible, true);
  assert.ok(figure.joints.rightUpperArm.rotation.x < -2.7, `right arm ${figure.joints.rightUpperArm.rotation.x}`);
  assert.equal(activityText(figure), 'Your turn · 4 min');
});

test('an orchestrating fresh your-turn shows no beacon and no raised hand, and stands hands on hips (issue #168)', () => {
  const figure = new StickFigure('agent', new THREE.Color(0x4a90d9));
  figure.setActivity('idle');
  figure.setAttention('your-turn', 4, true);
  run(figure, 3);
  assert.notEqual(beaconOf(figure)?.visible, true, 'orchestrating never shows the beacon, however fresh the wait');
  assert.ok(figure.joints.rightUpperArm.rotation.x > -2, 'not the raised-hand angle');
  assert.ok(Math.abs(figure.joints.rightUpperArm.rotation.z) > 0.1, 'hands on hips instead');
  assert.equal(activityText(figure), 'Your turn · 4 min', 'the label text is unchanged: only the pose and the signal differ');
});

test('the label never carries a title attribute, even while the beacon shows (issue #170 review: pointer-events none means it would never show anyway)', () => {
  const figure = new StickFigure('agent', new THREE.Color(0x4a90d9));
  figure.setAttention('waiting', 4);
  assert.equal(figure.label.element.title, '', 'the beacon hint moved to the card status line and figure hover; the dead title attribute is gone');
});

test('an aging or cold block keeps its label, with no beacon and no raised hand', () => {
  for (const minutes of [15, 24 * 60]) {
    const figure = new StickFigure('agent', new THREE.Color(0x4a90d9));
    figure.setActivity('implementing');
    figure.setAttention('waiting', minutes);
    run(figure, 3);
    assert.notEqual(beaconOf(figure)?.visible, true, `${minutes} min`);
    assert.ok(figure.joints.rightUpperArm.rotation.x > -1.5, `hand on the keyboard at ${minutes} min`);
    assert.match(activityText(figure) ?? '', /^Waiting for you · /);
  }
});

test('a block that ages past the fresh band loses its beacon on the next poll', () => {
  const figure = new StickFigure('agent', new THREE.Color(0x4a90d9));
  figure.setAttention('waiting', 14);
  assert.equal(beaconOf(figure)?.visible, true);
  figure.setAttention('waiting', 15);
  assert.equal(beaconOf(figure)?.visible, false);
});

test('a block without a wait time keeps the beacon, as before', () => {
  const figure = new StickFigure('agent', new THREE.Color(0x4a90d9));
  figure.setAttention('waiting', undefined);
  assert.equal(beaconOf(figure)?.visible, true);
});

test('a finished subagent figure reads "Done"; a main figure at rest keeps "Taking a break"', () => {
  const sub = new StickFigure('helper', new THREE.Color(0x4a90d9));
  sub.setSubagent(true);
  sub.setActivity('idle');
  assert.equal(activityText(sub), 'Done');
  sub.setActivity('researching');
  assert.equal(activityText(sub), 'Researching');

  const main = new StickFigure('main', new THREE.Color(0x4a90d9));
  main.setActivity('implementing');
  main.setActivity('idle');
  assert.equal(activityText(main), 'Taking a break');
});

test('a stuck figure reads "Stuck?" instead of its activity, and clears once it recovers', () => {
  const figure = new StickFigure('agent', new THREE.Color(0x4a90d9));
  figure.setActivity('implementing');
  figure.setStuck(true);
  assert.equal(activityText(figure), 'Stuck?');

  figure.setStuck(false);
  assert.equal(activityText(figure), 'Implementing');
});

test('a wait takes priority over a stuck mark in the label', () => {
  const figure = new StickFigure('agent', new THREE.Color(0x4a90d9));
  figure.setActivity('implementing');
  figure.setStuck(true);
  figure.setAttention('waiting', 2);
  assert.equal(activityText(figure), 'Waiting for you · 2 min');
});
