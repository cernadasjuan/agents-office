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
const { AgentManager } = await import('../src/agents/AgentManager.js');
const { StickFigure } = await import('../src/characters/StickFigure.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

function torsoColor(manager: InstanceType<typeof AgentManager>, id: string): string {
  const agent = manager.getAgents().find((managed) => managed.info.id === id)!;
  return (agent.figure.joints.torso.material as THREE.MeshToonMaterial).color.getHexString();
}

test('an agent gets the same color whatever the order in which agents arrive', () => {
  const first = new AgentManager(new THREE.Scene(), new Map());
  for (const id of ['a', 'b', 'session-x']) first.addAgent({ id, name: id, activity: 'idle' });
  const second = new AgentManager(new THREE.Scene(), new Map());
  second.addAgent({ id: 'session-x', name: 'session-x', activity: 'idle' });

  assert.equal(torsoColor(first, 'session-x'), torsoColor(second, 'session-x'));
});

test('the floating label shows the same friendly text as the panel', () => {
  const figure = new StickFigure('agent', new THREE.Color(0x4a90d9));
  figure.setActivity('writing_docs');

  assert.equal(figure.label.element.querySelector('.activity')?.textContent, 'Writing docs');
});

test('a subagent wears its parent color and stands smaller', () => {
  const manager = new AgentManager(new THREE.Scene(), new Map());
  manager.addAgent({ id: 'parent-session', name: 'parent', activity: 'idle' });
  manager.addAgent({ id: 'child-1', name: '>> child', activity: 'researching', extras: { parentId: 'parent-session' } });

  assert.equal(torsoColor(manager, 'child-1'), torsoColor(manager, 'parent-session'));
  const child = manager.getAgents().find((managed) => managed.info.id === 'child-1')!;
  const parent = manager.getAgents().find((managed) => managed.info.id === 'parent-session')!;
  assert.equal(child.figure.group.scale.y, 0.85);
  assert.equal(parent.figure.group.scale.y, 1);
});
