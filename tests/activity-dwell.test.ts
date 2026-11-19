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
const { createOffice } = await import('../src/scene/Office.js');
const { ActivityLayout } = await import('../src/layout/ActivityLayout.js');
const { AgentManager } = await import('../src/agents/AgentManager.js');
const { dwellMsFromSearch } = await import('../src/layout/registry.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

function clock() {
  let time = 0;
  return { now: () => time, advance: (ms: number) => { time += ms; } };
}

test('without a dwell time a station change is immediate, as before', () => {
  const layout = new ActivityLayout(createOffice(new THREE.Scene()));
  layout.seatFor({ id: 'a', activity: 'implementing' }, null);

  const seat = layout.seatFor({ id: 'a', activity: 'testing' }, 'implementing');

  assert.ok(seat && seat.key.startsWith('test'), `seat ${seat?.key}`);
  assert.deepEqual(layout.update(), []);
});

test('with a dwell time the agent moves only after the new activity lasted that long', () => {
  const time = clock();
  const layout = new ActivityLayout(createOffice(new THREE.Scene()), { dwellMs: 5000, now: time.now });
  const desk = layout.seatFor({ id: 'a', activity: 'implementing' }, null)!;

  assert.equal(layout.seatFor({ id: 'a', activity: 'testing' }, 'implementing'), null);
  time.advance(4999);
  assert.deepEqual(layout.update(), []);

  time.advance(1);
  const moves = layout.update() as Array<{ agentId: string; seat: { key: string } }>;
  assert.equal(moves.length, 1);
  assert.equal(moves[0].agentId, 'a');
  assert.ok(moves[0].seat.key.startsWith('test'), `seat ${moves[0].seat.key}`);
  assert.notEqual(moves[0].seat.key, desk.key);
  assert.deepEqual(layout.update(), []);
});

test('a change back before the dwell time ends cancels the trip and keeps the seat', () => {
  const time = clock();
  const stations = createOffice(new THREE.Scene());
  const layout = new ActivityLayout(stations, { dwellMs: 5000, now: time.now });
  const desk = layout.seatFor({ id: 'a', activity: 'implementing' }, null)!;

  layout.seatFor({ id: 'a', activity: 'testing' }, 'implementing');
  time.advance(2000);
  assert.equal(layout.seatFor({ id: 'a', activity: 'debugging' }, 'testing'), null);
  time.advance(10_000);

  assert.deepEqual(layout.update(), []);
  assert.equal(stations.get(desk.key)!.occupied, true);
});

test('a change to a third station type restarts the dwell time', () => {
  const time = clock();
  const layout = new ActivityLayout(createOffice(new THREE.Scene()), { dwellMs: 5000, now: time.now });
  layout.seatFor({ id: 'a', activity: 'implementing' }, null);

  layout.seatFor({ id: 'a', activity: 'testing' }, 'implementing');
  time.advance(3000);
  layout.seatFor({ id: 'a', activity: 'researching' }, 'testing');
  time.advance(3000);
  assert.deepEqual(layout.update(), []);

  time.advance(2000);
  const moves = layout.update() as Array<{ seat: { key: string } }>;
  assert.equal(moves.length, 1);
  assert.ok(moves[0].seat.key.startsWith('bookshelf'), `seat ${moves[0].seat.key}`);
});

test('an agent that leaves during the dwell time has no trip left', () => {
  const time = clock();
  const layout = new ActivityLayout(createOffice(new THREE.Scene()), { dwellMs: 5000, now: time.now });
  layout.seatFor({ id: 'a', activity: 'implementing' }, null);
  layout.seatFor({ id: 'a', activity: 'testing' }, 'implementing');

  layout.release('a');
  time.advance(6000);

  assert.deepEqual(layout.update(), []);
});

test('the agent walks after the dwell time and keeps its activity pose on arrival', () => {
  const time = clock();
  const layout = new ActivityLayout(createOffice(new THREE.Scene()), { dwellMs: 1000, now: time.now });
  const manager = new AgentManager(new THREE.Scene(), layout);
  manager.addAgent({ id: 'a', name: 'A', activity: 'implementing' });
  const managed = manager.getAgents()[0];
  const desk = managed.seat!.position.clone();

  manager.setActivity('a', 'testing');
  manager.update(0, 0.1);
  assert.ok(managed.figure.group.position.distanceTo(desk) < 1e-6, 'stays at the desk during the dwell time');

  time.advance(1000);
  for (let frame = 0; frame < 600; frame++) manager.update(frame / 60, 1 / 60);

  assert.ok(managed.seat!.key.startsWith('test'), `seat ${managed.seat!.key}`);
  assert.ok(managed.figure.group.position.distanceTo(managed.seat!.position) < 1e-6, 'arrives at the new station');
  const figure = managed.figure as unknown as { isMoving: boolean; activity: string };
  assert.equal(figure.isMoving, false);
  assert.equal(figure.activity, 'testing');
});

test('the dwell time comes from ?dwell= in seconds, from 0 to 30, default 0', () => {
  assert.equal(dwellMsFromSearch(''), 0);
  assert.equal(dwellMsFromSearch('?dwell=4'), 4000);
  assert.equal(dwellMsFromSearch('?layout=activity&dwell=2.5'), 2500);
  assert.equal(dwellMsFromSearch('?dwell=99'), 30_000);
  assert.equal(dwellMsFromSearch('?dwell=-3'), 0);
  assert.equal(dwellMsFromSearch('?dwell=soon'), 0);
});
