import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { Station } from '../src/scene/Office.js';

// Figure modules create DOM nodes at import time, so the document must exist first.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
// Toon materials paint a gradient on a canvas; the test needs only a context that accepts calls.
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { AgentManager } = await import('../src/agents/AgentManager.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

function twoDesks(): Map<string, Station> {
  return new Map([0, 1].map((i) => [`desk_${i}`, {
    type: 'implementing',
    position: new THREE.Vector3(5 + i * 3, 0, 0),
    lookAt: new THREE.Vector3(5 + i * 3, 1, -1),
    occupied: false,
  }]));
}

function positionKey(position: THREE.Vector3): string {
  return `${position.x.toFixed(2)},${position.z.toFixed(2)}`;
}

test('agents beyond the station count each get their own position', () => {
  const manager = new AgentManager(new THREE.Scene(), twoDesks());

  for (let i = 0; i < 6; i++) manager.addAgent({ id: `agent-${i}`, name: `Agent ${i}`, activity: 'implementing' });

  const positions = manager.getAgents().map((agent) => positionKey(agent.figure.group.position));
  assert.equal(new Set(positions).size, 6);
});

test('an overflow position is released and reused when its agent leaves', () => {
  const manager = new AgentManager(new THREE.Scene(), twoDesks());
  for (let i = 0; i < 3; i++) manager.addAgent({ id: `agent-${i}`, name: `Agent ${i}`, activity: 'implementing' });
  const overflowPosition = positionKey(manager.getAgents()[2].figure.group.position);
  assert.notEqual(overflowPosition, '0.00,0.00', 'the overflow agent must not stay at the scene origin');

  manager.removeAgent('agent-2');
  manager.addAgent({ id: 'agent-3', name: 'Agent 3', activity: 'implementing' });

  const newcomer = manager.getAgents().find((agent) => agent.info.id === 'agent-3')!;
  assert.equal(positionKey(newcomer.figure.group.position), overflowPosition);
});

test('an agent never takes a free seat of another activity type', () => {
  const manager = new AgentManager(new THREE.Scene(), twoDesks());

  manager.addAgent({ id: 'idle-agent', name: 'Idle', activity: 'idle' });

  const position = positionKey(manager.getAgents()[0].figure.group.position);
  assert.ok(!['5.00,0.00', '8.00,0.00'].includes(position), `idle agent sat at desk ${position}`);
});
