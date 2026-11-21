import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * Issue #191 review blocker 1: the flat "activity" layout (and any other layout that is not
 * floor-aware) never calls `setFocusedFloor` at all — only `main.ts`'s building-layout branch
 * does. Before this fix the module default was `GENERAL_FLOOR`, a specific, selectable floor:
 * `plugins/github/client.ts`'s `worldChanged` reads `focusedFloor()` unconditionally and would
 * filter every kanban board against that default, keeping none. The default must read as "no
 * floor chosen yet," the same as every other layout already behaves, not as a floor.
 */
test('focusedFloor defaults to ALL_FLOORS before anything ever calls setFocusedFloor (issue #191 review: a non-building layout never sets it)', async () => {
  const { ALL_FLOORS } = await import('../src/floors/FloorRegistry.js');
  const { focusedFloor } = await import('../src/floors/floorState.js');
  assert.equal(focusedFloor(), ALL_FLOORS);
});

test('the activity-layout scenario: a GitHub kanban board still shows when nothing has ever focused a floor', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
  try {
    const THREE = await import('three');
    const { GithubOfficeExtension } = await import('../plugins/github/client.js');
    // No setFocusedFloor call anywhere in this module graph: the exact state the flat
    // "activity" layout leaves focusedFloor() in, since it never sets it at all.
    const scene = new THREE.Scene();
    const extension = new GithubOfficeExtension();
    extension.start(scene);
    extension.worldChanged({
      plugins: ['github'], rooms: [], jiraTickets: [],
      boards: [{ id: 'b', title: 'o/r', repo: 'o/r', columns: [{ name: 'To do', cards: [{ number: 1, title: 'x' }] }] }],
    });
    assert.equal(scene.children.filter((child) => child.name === 'github-kanban').length, 1);
  } finally {
    dom.window.close();
    Reflect.deleteProperty(globalThis, 'document');
  }
});
