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
const { bmadHats, MAX_HATS } = await import('../plugins/bmad/client.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

function hatsOn(managed: ManagedAgent): THREE.Object3D[] {
  const stack = managed.figure.joints.head.getObjectByName('bmad-hats');
  return stack ? stack.children.filter((child) => typeof child.userData.badge === 'string') : [];
}

function moreText(managed: ManagedAgent): string | undefined {
  const stack = managed.figure.joints.head.getObjectByName('bmad-hats');
  const more = stack?.getObjectByName('bmad-more') as { element?: HTMLElement } | undefined;
  return more?.element?.textContent ?? undefined;
}

function activityText(managed: ManagedAgent): string | null | undefined {
  return managed.figure.label.element.querySelector('.activity')?.textContent;
}

function setup() {
  const scene = new THREE.Scene();
  const manager = new AgentManager(scene, new Map());
  return { scene, manager };
}

test('the extension runs only while the bmad server plugin is active', () => {
  const scene = new THREE.Scene();
  setWorld(EMPTY_WORLD);
  assert.equal(activeExtensions(scene).some((extension) => extension.id === bmadHats.id), false);
  setWorld({ ...EMPTY_WORLD, plugins: ['bmad'] });
  assert.equal(activeExtensions(scene).some((extension) => extension.id === bmadHats.id), true);
  setWorld(EMPTY_WORLD);
  assert.equal(bmadHats.plugin, 'bmad');
});

test('one hat per badge, stacked upward, and persona names on the label', () => {
  const { manager } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'researching', extras: { badges: ['ux-designer', 'architect'] } });
  const [managed] = manager.getAgents();
  bmadHats.agentsChanged!(manager.getAgents());

  const hats = hatsOn(managed);
  assert.deepEqual(hats.map((hat) => hat.userData.badge), ['ux-designer', 'architect']);
  assert.ok(hats[1].position.y > hats[0].position.y);
  assert.equal(activityText(managed), 'Researching · Sally, Winston');
  assert.equal(moreText(managed), undefined);
});

test('personas get different hats and unknown badges get a party hat', () => {
  const { manager } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'implementing', extras: { badges: ['pm', 'qa', 'brainstorming-coach', 'constructor'] } });
  const [managed] = manager.getAgents();
  bmadHats.agentsChanged!(manager.getAgents());

  assert.deepEqual(hatsOn(managed).map((hat) => hat.userData.hat), ['top-hat', 'detective-cap', 'party-hat', 'party-hat']);
});

test('more than four badges show four hats and a +N marker, the label lists every name', () => {
  const { manager } = setup();
  const badges = ['analyst', 'architect', 'dev', 'qa', 'pm', 'sm'];
  manager.addAgent({ id: 'a', name: 'A', activity: 'testing', extras: { badges } });
  const [managed] = manager.getAgents();
  bmadHats.agentsChanged!(manager.getAgents());

  assert.equal(MAX_HATS, 4);
  assert.equal(hatsOn(managed).length, 4);
  assert.equal(moreText(managed), '+2');
  assert.equal(activityText(managed), 'Running tests · Mary, Winston, Amelia, Quinn, John, Bob');
});

test('hats follow badge changes and leave with the badge or the agent', () => {
  const { manager } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'planning', extras: { badges: ['debugger'] } });
  manager.addAgent({ id: 'b', name: 'B', activity: 'planning' });
  const [first, second] = manager.getAgents();
  bmadHats.agentsChanged!(manager.getAgents());
  assert.equal(hatsOn(first).length, 1);
  assert.equal(hatsOn(second).length, 0);
  assert.equal(activityText(second), 'Planning');

  const disposed: string[] = [];
  hatsOn(first)[0].traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry.addEventListener('dispose', () => disposed.push(object.uuid));
  });
  manager.setExtras('a', { badges: ['debugger', 'spec-coach'] });
  bmadHats.agentsChanged!(manager.getAgents());
  assert.equal(hatsOn(first).length, 2);
  assert.ok(disposed.length > 0);

  manager.setExtras('a', undefined);
  bmadHats.agentsChanged!(manager.getAgents());
  assert.equal(hatsOn(first).length, 0);
  assert.equal(first.figure.joints.head.getObjectByName('bmad-hats'), undefined);
  assert.equal(activityText(first), 'Planning');

  manager.setExtras('a', { badges: ['sm'] });
  bmadHats.agentsChanged!(manager.getAgents());
  const stack = first.figure.joints.head.getObjectByName('bmad-hats')!;
  manager.removeAgent('a');
  bmadHats.agentsChanged!(manager.getAgents());
  assert.equal(stack.parent, null);
});

test('the label text stays plain text', () => {
  const { manager } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle', extras: { badges: ['b-img-src-x-onerror'] } });
  const [managed] = manager.getAgents();
  bmadHats.agentsChanged!(manager.getAgents());

  assert.equal(managed.figure.label.element.querySelector('img'), null);
  assert.equal(activityText(managed), 'Taking a break · b-img-src-x-onerror');
});
