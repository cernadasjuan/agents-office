import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { World, WorldJiraTicket } from '../src/extensions.js';
import type { ManagedAgent } from '../src/agents/AgentManager.js';
import type { AgentInfo } from '../src/agents/AgentData.js';

// Toon materials and canvas textures need a document and a 2D context stub.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
const drawn: string[] = [];
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: (_target, key) => {
    if (key === 'fillText') return (text: string) => { drawn.push(text); };
    if (key === 'measureText') return (text: string) => ({ width: text.length * 10 });
    return () => undefined;
  },
  set: () => true,
})) as never;
const { DeskMonitorsExtension, drawMiniBoard } = await import('../src/addons/building/deskMonitors.js');
const { countDrawCalls } = await import('../src/scene/RenderBudget.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

function officeScene(): THREE.Scene {
  const scene = new THREE.Scene();
  const office = new THREE.Group();
  office.name = 'room-0-office';
  scene.add(office);
  return scene;
}

function managed(id: string, name: string, overrides: Partial<AgentInfo> = {}): ManagedAgent {
  return { info: { id, name, activity: 'idle', ...overrides } } as unknown as ManagedAgent;
}

function world(jiraTickets: WorldJiraTicket[] = []): World {
  return { plugins: jiraTickets.length > 0 ? ['jira'] : [], rooms: [], boards: [], jiraTickets };
}

test('without the office room in the scene, neither monitor mounts', () => {
  const extension = new DeskMonitorsExtension();
  const scene = new THREE.Scene(); // no office room (e.g. the activity layout)
  extension.start(scene);
  extension.agentsChanged([]);
  extension.worldChanged(world([{ key: 'KTP-1', summary: 'x', status: 'Open' }]));
  assert.equal(countDrawCalls(scene).main, 0);
});

test('the waiting-list monitor always mounts once the office exists, even with an empty queue', () => {
  const extension = new DeskMonitorsExtension();
  const scene = officeScene();
  extension.start(scene);
  extension.agentsChanged([]);
  scene.updateMatrixWorld();
  assert.ok(countDrawCalls(scene).main > 0, 'the frame and the face both draw');
  assert.ok(drawn.includes('Waiting'));
  assert.ok(drawn.includes('Nobody is waiting'));
});

test('the waiting-list monitor lists the triage queue, needs-you before your-turn, by wait', () => {
  drawn.length = 0;
  const extension = new DeskMonitorsExtension();
  const scene = officeScene();
  extension.start(scene);
  extension.agentsChanged([
    managed('a', 'Needs You', { extras: { attention: 'waiting', waitMinutes: 5 } }),
    managed('b', 'Your Turn', { extras: { attention: 'your-turn', waitMinutes: 1 } }),
    managed('c', 'Cold', { extras: { attention: 'waiting', waitMinutes: 2000 } }),
  ]);
  const indexOf = (name: string) => drawn.indexOf(name);
  assert.ok(indexOf('Needs You') >= 0, 'needs-you is in the queue');
  assert.ok(indexOf('Your Turn') >= 0, 'your-turn is in the queue');
  assert.equal(indexOf('Cold'), -1, 'a cold wait never queues (the same rule key N uses)');
  assert.ok(indexOf('Needs You') < indexOf('Your Turn'), 'needs-you lists before your-turn');
});

test('the Jira monitor mounts only while there is Jira data (graceful degradation, issue #145)', () => {
  const extension = new DeskMonitorsExtension();
  const scene = officeScene();
  extension.start(scene);
  extension.agentsChanged([]);
  const withoutJira = countDrawCalls(scene).main;

  extension.worldChanged(world([{ key: 'KTP-1', summary: 'x', status: 'Open' }]));
  const withJira = countDrawCalls(scene).main;
  assert.ok(withJira > withoutJira, 'the Jira monitor mounts once there is data');
  assert.ok(drawn.includes('KTP-1 (Open)') || drawn.some((text) => text.includes('KTP-1')));

  extension.worldChanged(world([])); // the sprint empties out, or the plugin goes off
  assert.equal(countDrawCalls(scene).main, withoutJira, 'the Jira monitor unmounts again');
});

test('render budget (issue #161): both monitors together cost at most 4 draw calls, the waiting list alone at most 2', () => {
  const extension = new DeskMonitorsExtension();
  const scene = officeScene();
  extension.start(scene);

  extension.agentsChanged([]);
  scene.updateMatrixWorld();
  const waitingOnly = countDrawCalls(scene).main;
  assert.ok(waitingOnly <= 2, `the waiting-list monitor (frame + face) costs ${waitingOnly} draw calls`);

  extension.worldChanged(world([{ key: 'KTP-1', summary: 'x', status: 'Open' }]));
  scene.updateMatrixWorld();
  const both = countDrawCalls(scene).main;
  assert.ok(both <= 4, `both monitors together cost ${both} draw calls`);
});

test('drawMiniBoard shows the title, up to 5 rows, and an empty message without any', () => {
  drawn.length = 0;
  const canvas = dom.window.document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 200;
  drawMiniBoard(canvas, 'Waiting', ['A', 'B', 'C', 'D', 'E', 'F'], 'Nobody is waiting');
  assert.ok(drawn.includes('Waiting'));
  for (const name of ['A', 'B', 'C', 'D', 'E']) assert.ok(drawn.includes(name));
  assert.equal(drawn.includes('F'), false, 'only the first 5 rows draw');
  assert.ok(drawn.some((text) => text.includes('+1 more')));

  drawn.length = 0;
  drawMiniBoard(canvas, 'Waiting', [], 'Nobody is waiting');
  assert.ok(drawn.includes('Nobody is waiting'));
});
