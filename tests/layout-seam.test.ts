import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { Activity } from '../src/agents/ActivityAnimations.js';
import type { LayoutAgent, LayoutStrategy, Seat } from '../src/layout/LayoutStrategy.js';

// Toon materials paint a gradient on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { AgentManager } = await import('../src/agents/AgentManager.js');
const { buildSkeleton, HIP_HEIGHT } = await import('../src/characters/StickFigureParts.js');
// Issue #165's Hero body shortened the legs, moving the standing hip height off the
// pre-Hero 0.9; round 7 re-tuned the seated drop so hips land on the seat, not below it
// (ActivityAnimations.ts's SEATED_HIP_HEIGHT) — read the real constant, not a second
// hardcoded copy of it.
const { animateActivity, SEATED_HIP_HEIGHT } = await import('../src/agents/ActivityAnimations.js');
const registry = await import('../src/layout/registry.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

class RecordingLayout implements LayoutStrategy {
  readonly id = 'recording';
  calls: string[] = [];
  seatFor(agent: LayoutAgent, previous: Activity | null): Seat | null {
    this.calls.push(`seat ${agent.id} ${previous ?? 'new'}>${agent.activity}`);
    if (previous === 'implementing' && agent.activity === 'debugging') return null;
    const x = agent.activity === 'idle' ? 10 : 3;
    return { key: `${agent.id}-${x}`, position: new THREE.Vector3(x, 0, 0), lookAt: new THREE.Vector3(x, 1, -1) };
  }
  release(agentId: string): void {
    this.calls.push(`release ${agentId}`);
  }
}

test('the manager places agents where the layout says and tells it when they leave', () => {
  const layout = new RecordingLayout();
  const manager = new AgentManager(new THREE.Scene(), layout);

  manager.addAgent({ id: 'a', name: 'A', activity: 'implementing' });
  const figure = manager.getAgents()[0].figure;
  assert.equal(figure.group.position.x, 3);

  manager.setActivity('a', 'debugging');
  manager.setActivity('a', 'idle');
  manager.removeAgent('a');

  assert.deepEqual(layout.calls, [
    'seat a new>implementing',
    'seat a implementing>debugging',
    'seat a debugging>idle',
    'release a',
  ]);
});

test('the layout choice follows the URL, then the stored choice, then the default', () => {
  registry.registerLayout('test-layout', () => new RecordingLayout());
  const storage = { getItem: () => 'test-layout' };

  assert.equal(registry.chooseLayoutId('?layout=activity', storage), 'activity');
  assert.equal(registry.chooseLayoutId('', storage), 'test-layout');
  assert.equal(registry.chooseLayoutId('?layout=unknown', undefined), 'activity');
  assert.equal(registry.chooseLayoutId('', { getItem: () => 'gone' }), 'activity');
});

test('an add-on can make its layout the default when the user chose none', () => {
  registry.registerLayout('addon-default', () => new RecordingLayout(), { makeDefault: true });

  assert.equal(registry.chooseLayoutId('', undefined), 'addon-default');
  assert.equal(registry.chooseLayoutId('?layout=activity', undefined), 'activity');
});

function settle(posture: 'seated' | 'standing' | undefined, activity: Activity): number {
  const joints = buildSkeleton(new THREE.Color(0x4a90d9));
  for (let t = 0; t < 3; t += 1 / 60) animateActivity(joints, activity, t, 1 / 60, posture);
  return joints.hips.position.y;
}

test('a seat can make an agent sit or stand whatever its activity', () => {
  assert.ok(Math.abs(settle(undefined, 'idle') - HIP_HEIGHT) < 0.01, 'idle stands by default');
  assert.ok(Math.abs(settle('seated', 'idle') - SEATED_HIP_HEIGHT) < 0.01, 'idle sits on a sofa');
  assert.ok(Math.abs(settle(undefined, 'implementing') - SEATED_HIP_HEIGHT) < 0.01, 'implementing sits by default');
  assert.ok(Math.abs(settle('standing', 'implementing') - HIP_HEIGHT) < 0.01, 'implementing stands on an open spot');
});

test('an overflow spot makes the agent stand', () => {
  const stations = new Map([['desk_0', {
    type: 'implementing', position: new THREE.Vector3(5, 0, 0), lookAt: new THREE.Vector3(5, 1, -1), occupied: true,
  }]]);
  const manager = new AgentManager(new THREE.Scene(), stations);
  manager.addAgent({ id: 'late', name: 'Late', activity: 'implementing' });

  assert.equal(manager.getAgents()[0].seat?.posture, 'standing');
});

test('a codex agent shows a codex tag in its floating label; a Claude agent shows none', () => {
  const manager = new AgentManager(new THREE.Scene(), new RecordingLayout());

  manager.addAgent({ id: 'c', name: 'billing-service', activity: 'testing', extras: { provider: 'codex' } });
  manager.addAgent({ id: 'k', name: 'claude-agent', activity: 'testing' });
  const activityText = (id: string) => manager.getAgents().find((agent) => agent.info.id === id)!
    .figure.label.element.querySelector('.activity')!.textContent;

  assert.match(activityText('c')!, / · codex$/);
  assert.doesNotMatch(activityText('k')!, /codex/);
  manager.setActivity('c', 'idle');
  assert.match(activityText('c')!, / · codex$/);
});

test('the floating label updates when parentId appears or disappears after creation', () => {
  const manager = new AgentManager(new THREE.Scene(), new RecordingLayout());
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  const label = () => manager.getAgents()[0].figure.label.element.querySelector('.activity')!.textContent;

  assert.doesNotMatch(label()!, /Done/, 'a main agent at rest keeps its activity label');

  manager.setExtras('a', { parentId: 'main' });
  assert.match(label()!, /Done/, 'the figure becomes a subagent once parentId appears');

  manager.setExtras('a', undefined);
  assert.doesNotMatch(label()!, /Done/, 'the figure reverts once parentId disappears');
});

test('a layout can move an agent on its own from its update hook', () => {
  const later: Seat = { key: 'later', position: new THREE.Vector3(9, 0, 9), lookAt: new THREE.Vector3(9, 1, 8) };
  let moved = false;
  const layout: LayoutStrategy = {
    id: 'mover',
    seatFor: () => ({ key: 'start', position: new THREE.Vector3(1, 0, 1), lookAt: new THREE.Vector3(1, 1, 0) }),
    release: () => undefined,
    update: () => {
      if (moved) return [];
      moved = true;
      return [{ agentId: 'a', seat: later }, { agentId: 'gone', seat: later }];
    },
  };
  const manager = new AgentManager(new THREE.Scene(), layout);
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });

  for (let t = 0; t < 6; t += 1 / 30) manager.update(t, 1 / 30);

  assert.equal(manager.getAgents()[0].seat?.key, 'later');
  assert.ok(manager.getAgents()[0].figure.group.position.distanceTo(later.position) < 0.1);
});
