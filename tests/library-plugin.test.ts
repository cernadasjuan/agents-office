import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import { libraryPlugin, parseLibrarianTypes } from '../plugins/library/index.js';
import { projectAgents, type Observation } from '../server/seam.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
const { AgentManager } = await import('../src/agents/AgentManager.js');
const { syncBooks } = await import('../plugins/library/client.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const observation = (id: string, agentType?: string, parentId?: string): Observation =>
  ({ id, provider: 'claude', name: id, activity: 'researching', ...(parentId ? { parentId } : {}), internal: { ...(agentType ? { agentType } : {}) }, display: {} });

test('subagents of a librarian type get the librarian role, and only subagents', async () => {
  const list = [observation('lib', 'bibliotheque-librarian', 'p'), observation('explore', 'Explore', 'p'), observation('main', 'bibliotheque-librarian')];
  await libraryPlugin(parseLibrarianTypes(undefined)).enrichers![0].enrich(list);
  assert.deepEqual(list.map((o) => o.display.role), ['librarian', undefined, undefined]);
});

test('issue #248 review: a top-level session carrying the librarian persona badge gets the role too, not only a subagent of a configured agent type', async () => {
  const topLevel: Observation = { ...observation('main-session'), display: { badges: ['librarian'] } };
  const subagentNoType: Observation = { ...observation('sub', undefined, 'main-session'), display: { badges: ['librarian'] } };
  const notLibrarian: Observation = { ...observation('other'), display: { badges: ['architect'] } };
  const list = [topLevel, subagentNoType, notLibrarian];
  await libraryPlugin(parseLibrarianTypes(undefined)).enrichers![0].enrich(list);
  assert.deepEqual(list.map((o) => o.display.role), ['librarian', 'librarian', undefined]);
});

test('the librarian types are configurable and validated', () => {
  assert.deepEqual(parseLibrarianTypes('Explore, bad type!,bibliotheque-librarian'), ['Explore', 'bibliotheque-librarian']);
  assert.deepEqual(parseLibrarianTypes(''), ['bibliotheque-librarian']);
});

test('the role reaches the browser only as a clean single token', () => {
  const [good, bad] = projectAgents([
    { ...observation('a'), display: { role: 'librarian' } },
    { ...observation('b'), display: { role: 'not a token!' } },
  ], (id) => `h(${id})`);
  assert.equal(good.role, 'librarian');
  assert.equal('role' in bad, false);
});

test('a librarian carries a book, which goes away when the role does', () => {
  const manager = new AgentManager(new THREE.Scene(), new Map());
  manager.addAgent({ id: 'lib', name: 'lib', activity: 'researching', extras: { role: 'librarian' } });
  syncBooks(manager.getAgents());
  const hand = manager.getAgents()[0].figure.joints.rightHand;
  assert.ok(hand.getObjectByName('librarian-book'));
  manager.setExtras('lib', undefined);
  syncBooks(manager.getAgents());
  assert.equal(hand.getObjectByName('librarian-book'), undefined);
});
