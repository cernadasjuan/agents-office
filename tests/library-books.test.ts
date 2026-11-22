import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// Toon materials paint a gradient on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
const { AgentManager } = await import('../src/agents/AgentManager.js');
const { FigureBatch } = await import('../src/characters/FigureBatch.js');
const { countDrawCalls } = await import('../src/scene/RenderBudget.js');
const { syncBooks } = await import('../plugins/library/client.js');

after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

function librarianAgents(manager: InstanceType<typeof AgentManager>, count: number): void {
  for (let i = 0; i < count; i++) {
    manager.addAgent({ id: `librarian-${i}`, name: `Librarian ${i}`, activity: 'researching', extras: { role: 'librarian' } });
  }
}

/**
 * Issue #253 review: broadening `role: 'librarian'` to any persona-badged agent (not only a
 * librarian subagent) also broadened who gets the unbatched book prop this extension used to
 * add — one `Mesh` per agent, never drawn through the shared figure batch. At real scale
 * (dozens of concurrent librarian-persona sessions) that alone would have pushed the office
 * past its 430 draw-call budget. The fix routes the book through `FigureBatch` the same way
 * `plugins/bmad/hats.ts` already does for its own per-figure prop: one shared geometry
 * instance, `userData.figurePart` set, so every book folds into one bucket regardless of how
 * many librarians carry one.
 */
test('issue #253 review: 30 librarian agents add only one new draw call for their books, never one per agent', () => {
  const scene = new THREE.Scene();
  const manager = new AgentManager(scene, new Map());
  librarianAgents(manager, 30);
  const agents = manager.getAgents();
  const figureGroups = agents.map((managed) => managed.figure.group);

  // Same 30 figures, same colors, same batch: the only variable is whether `syncBooks` ran.
  // Isolates the book's own marginal draw-call cost from the figures' own base cost (bodies,
  // hair, per-agent tints — already covered by other budget tests).
  const batch = new FigureBatch(scene);
  batch.sync(figureGroups);
  scene.updateMatrixWorld();
  const withoutBooks = countDrawCalls(scene).main;

  syncBooks(agents);
  batch.sync(figureGroups);
  scene.updateMatrixWorld();
  const withBooks = countDrawCalls(scene).main;

  assert.equal(withBooks - withoutBooks, 1, `30 librarians' books cost ${withBooks - withoutBooks} extra draw calls, not 1 — not folding into one shared bucket`);
});

test('a book appears in the right hand only while the agent carries the librarian role, and is removed (not disposed) when it stops', () => {
  const scene = new THREE.Scene();
  const manager = new AgentManager(scene, new Map());
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle', extras: { role: 'librarian' } });
  let [managed] = manager.getAgents();
  syncBooks(manager.getAgents());
  assert.ok(managed.figure.joints.rightHand.getObjectByName('librarian-book'), 'the book mounts while the role is librarian');

  manager.setExtras('a', undefined);
  [managed] = manager.getAgents();
  syncBooks(manager.getAgents());
  assert.equal(managed.figure.joints.rightHand.getObjectByName('librarian-book'), undefined, 'the book is removed once the role is gone');

  // A second agent's own book must still render correctly — proof the shared geometry was
  // never disposed by the first agent's own removal.
  manager.addAgent({ id: 'b', name: 'B', activity: 'idle', extras: { role: 'librarian' } });
  syncBooks(manager.getAgents());
  const second = manager.getAgents().find((candidate) => candidate.info.id === 'b')!;
  const book = second.figure.joints.rightHand.getObjectByName('librarian-book') as THREE.Mesh;
  assert.ok(book, 'a later librarian still gets a book');
  assert.ok(book.geometry.attributes.position, 'the shared geometry was never disposed by an earlier agent\'s own removal');
});
