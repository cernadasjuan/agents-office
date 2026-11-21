import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { ManagedAgent } from '../src/agents/AgentManager.js';

// Toon materials paint a gradient on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { AgentManager } = await import('../src/agents/AgentManager.js');
const { activeExtensions, setWorld, EMPTY_WORLD } = await import('../src/extensions.js');
const { skillsEquipment } = await import('../plugins/skills/client.js');
const { handItemFor, faceItemFor, buildHandItem } = await import('../plugins/skills/items.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

function handOn(managed: ManagedAgent): THREE.Object3D | undefined {
  return managed.figure.joints.rightHand.children.find((child) => child.userData.skillsHandItem);
}

function faceOn(managed: ManagedAgent): THREE.Object3D | undefined {
  return managed.figure.joints.head.children.find((child) => child.userData.skillsFaceItem);
}

function setup() {
  const scene = new THREE.Scene();
  const manager = new AgentManager(scene, new Map());
  return { scene, manager };
}

test('the extension runs only while the skills server plugin is active', () => {
  const scene = new THREE.Scene();
  setWorld(EMPTY_WORLD);
  assert.equal(activeExtensions(scene).some((extension) => extension.id === skillsEquipment.id), false);
  setWorld({ ...EMPTY_WORLD, plugins: ['skills'] });
  assert.equal(activeExtensions(scene).some((extension) => extension.id === skillsEquipment.id), true);
  setWorld(EMPTY_WORLD);
});

test('an agent with no skills wears no hand or face item', () => {
  const { manager } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  const [managed] = manager.getAgents();
  skillsEquipment.agentsChanged!(manager.getAgents());
  assert.equal(handOn(managed), undefined);
  assert.equal(faceOn(managed), undefined);
});

test('the newest (last) skill decides the hand item, not the first one used', () => {
  const { manager } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle', extras: { skills: ['git', 'jira'] } });
  const [managed] = manager.getAgents();
  skillsEquipment.agentsChanged!(manager.getAgents());
  const hand = handOn(managed)!;
  assert.ok(hand, 'expected a hand item');
  assert.equal(hand.name, 'clipboard', 'jira (the newest skill) should equip the clipboard, not git\'s wrench');
});

test('an unmapped skill still equips an item: the hashed toolbox, never nothing', () => {
  const { manager } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle', extras: { skills: ['some-unknown-skill'] } });
  const [managed] = manager.getAgents();
  skillsEquipment.agentsChanged!(manager.getAgents());
  assert.ok(handOn(managed), 'an unmapped skill still gets the toolbox fallback');
});

test('a face item appears only for a headphone-worthy skill, or once skill variety is established; never for one bare skill', () => {
  assert.equal(faceItemFor([]), undefined);
  assert.equal(faceItemFor(['git']), undefined);
  assert.equal(faceItemFor(['git', 'jira']), 'glasses');
  assert.equal(faceItemFor(['git', 'klever-test']), 'headphones');
  assert.equal(faceItemFor(['klever-test']), 'headphones', 'a headphone-worthy skill wins even alone');
});

test('the head slot stays the persona hat\'s: the face item attaches under the head but never under the bmad-hats stack', () => {
  const { manager } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle', extras: { skills: ['git', 'jira'] } });
  const [managed] = manager.getAgents();
  skillsEquipment.agentsChanged!(manager.getAgents());
  const face = faceOn(managed);
  assert.ok(face);
  assert.equal(face!.parent, managed.figure.joints.head);
});

test('items follow skill changes and leave with the agent', () => {
  const { manager } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle', extras: { skills: ['git'] } });
  manager.addAgent({ id: 'b', name: 'B', activity: 'idle' });
  const [first, second] = manager.getAgents();
  skillsEquipment.agentsChanged!(manager.getAgents());
  assert.ok(handOn(first));
  assert.equal(handOn(second), undefined);

  manager.setExtras('a', { skills: ['git', 'jira'] });
  skillsEquipment.agentsChanged!(manager.getAgents());
  assert.ok(handOn(first), 'still equipped, now the clipboard');

  manager.setExtras('a', undefined);
  skillsEquipment.agentsChanged!(manager.getAgents());
  assert.equal(handOn(first), undefined);

  manager.setExtras('a', { skills: ['git'] });
  skillsEquipment.agentsChanged!(manager.getAgents());
  const item = handOn(first)!;
  manager.removeAgent('a');
  skillsEquipment.agentsChanged!(manager.getAgents());
  assert.equal(item.parent, null);
});

test('two skills mapped to the same kind (jira and klever-mr, both clipboards) share one geometry, tinted apart', () => {
  const jira = handItemFor(['jira'])!;
  const kleverMr = handItemFor(['klever-mr'])!;
  assert.equal(jira.kind, 'clipboard');
  assert.equal(kleverMr.kind, 'clipboard');
  assert.equal(jira.tint, undefined, 'the base clipboard carries no tint');
  assert.ok(kleverMr.tint, 'the klever-mr clipboard is tinted apart from the base one');
});

// --- Round 2 (issue #167): raw built-in tool items, keyed on extras.tools ---

test('a raw tool call equips the matching item: Bash the terminal screen, Grep/Glob and Read reusing magnifier/open-book', () => {
  assert.equal(handItemFor([], ['Bash'])!.kind, 'terminal-screen');
  assert.equal(handItemFor([], ['Grep'])!.kind, 'magnifier');
  assert.equal(handItemFor([], ['Glob'])!.kind, 'magnifier');
  assert.equal(handItemFor([], ['Edit'])!.kind, 'pencil');
  assert.equal(handItemFor([], ['Write'])!.kind, 'pencil');
  assert.equal(handItemFor([], ['Read'])!.kind, 'open-book');
  assert.equal(handItemFor([], ['WebSearch'])!.kind, 'globe');
  assert.equal(handItemFor([], ['WebFetch'])!.kind, 'globe');
});

test('Read (a tool) and research (a skill) share the open-book shape, tinted apart, the same pattern as jira/klever-mr', () => {
  const read = handItemFor([], ['Read'])!;
  const research = handItemFor(['research'])!;
  assert.equal(read.kind, 'open-book');
  assert.equal(research.kind, 'open-book');
  assert.equal(read.tint, undefined, 'the tool-triggered book carries no tint');
  assert.ok(research.tint, 'the skill-triggered book is tinted apart from the tool one');
});

test('with no lastEquipSource signal (an older server, or a fixture that never set it), skills win over tools when both are present', () => {
  const item = handItemFor(['git'], ['Bash'])!;
  assert.equal(item.kind, 'wrench', 'skills win by default so an old server never regresses');
});

test('lastEquipSource picks the true newest across both lists, even against the default preference', () => {
  assert.equal(handItemFor(['git'], ['Bash'], 'tool')!.kind, 'terminal-screen', 'the tool call came later');
  assert.equal(handItemFor(['git'], ['Bash'], 'skill')!.kind, 'wrench', 'the skill call came later');
});

test('with only tools and no skills, tools equip the hand even with no lastEquipSource signal', () => {
  assert.equal(handItemFor([], ['Bash'])!.kind, 'terminal-screen');
});

test('an unmapped tool (Task) still equips the hashed toolbox, never nothing', () => {
  const item = handItemFor([], ['Task'])!;
  assert.equal(item.kind, 'toolbox');
  assert.ok(item.tint);
});

test('a hand item is scaled up from its raw template (issue #167 review: v1 items read too small at crowd zoom)', () => {
  const group = buildHandItem({ kind: 'wrench' });
  assert.ok(group.scale.x > 1, `expected a scale-up, got ${group.scale.x}`);
});

test('the client reads extras.tools and extras.lastEquipSource to equip the right hand item', () => {
  const { manager } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle', extras: { skills: ['git'], tools: ['Bash'], lastEquipSource: 'tool' } });
  const [managed] = manager.getAgents();
  skillsEquipment.agentsChanged!(manager.getAgents());
  const hand = handOn(managed)!;
  assert.ok(hand);
  assert.equal(hand.name, 'terminal-screen', 'Bash, the true newest entry per lastEquipSource, should equip the terminal screen, not git\'s wrench');
});
