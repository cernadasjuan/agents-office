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
const { buildSkeleton } = await import('../src/characters/StickFigureParts.js');
const { animateActivity } = await import('../src/agents/ActivityAnimations.js');
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
  assert.ok(Math.abs(settle(undefined, 'idle') - 0.9) < 0.01, 'idle stands by default');
  assert.ok(Math.abs(settle('seated', 'idle') - 0.5) < 0.01, 'idle sits on a sofa');
  assert.ok(Math.abs(settle(undefined, 'implementing') - 0.5) < 0.01, 'implementing sits by default');
  assert.ok(Math.abs(settle('standing', 'implementing') - 0.9) < 0.01, 'implementing stands on an open spot');
});

test('an overflow spot makes the agent stand', () => {
  const stations = new Map([['desk_0', {
    type: 'implementing', position: new THREE.Vector3(5, 0, 0), lookAt: new THREE.Vector3(5, 1, -1), occupied: true,
  }]]);
  const manager = new AgentManager(new THREE.Scene(), stations);
  manager.addAgent({ id: 'late', name: 'Late', activity: 'implementing' });

  assert.equal(manager.getAgents()[0].seat?.posture, 'standing');
});
