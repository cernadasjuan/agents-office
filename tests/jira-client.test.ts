import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { World, WorldJiraTicket } from '../src/extensions.js';

// Canvas textures need a document and a 2D context stub.
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
const { JiraOfficeExtension, drawJiraBoard } = await import('../plugins/jira/client.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

function ticket(key: string, overrides: Partial<WorldJiraTicket> = {}): WorldJiraTicket {
  return { key, summary: `Summary ${key}`, status: 'In Progress', url: `https://beklever.atlassian.net/browse/${key}`, ...overrides };
}

function world(jiraTickets: WorldJiraTicket[]): World {
  return { plugins: ['jira'], rooms: [], boards: [], jiraTickets, libraries: [] };
}

function officeScene(): THREE.Scene {
  const scene = new THREE.Scene();
  const office = new THREE.Group();
  office.name = 'room-0-office';
  scene.add(office);
  return scene;
}

test('without the office room in the scene, no board mounts even with tickets', () => {
  const extension = new JiraOfficeExtension();
  const scene = new THREE.Scene(); // no office room (e.g. the activity layout)
  extension.start(scene);
  extension.worldChanged(world([ticket('KTP-1')]));
  assert.equal(scene.getObjectByName('jira-board'), undefined);
});

test('with the office room and no tickets, no board mounts (disabled, no credentials, or an empty sprint)', () => {
  const extension = new JiraOfficeExtension();
  const scene = officeScene();
  extension.start(scene);
  extension.worldChanged(world([]));
  assert.equal(scene.getObjectByName('jira-board'), undefined);
});

test('with the office room and tickets, a board mounts once with the ticket text drawn', () => {
  drawn.length = 0;
  const extension = new JiraOfficeExtension();
  const scene = officeScene();
  extension.start(scene);
  extension.worldChanged(world([ticket('KTP-1', { summary: 'Fix the thing', priority: 'High' })]));

  const board = scene.getObjectByName('jira-board');
  assert.ok(board, 'the board group is in the scene');
  assert.ok(drawn.includes('KTP-1'));
  assert.ok(drawn.some((text) => text.includes('Fix the thing')));
});

test('a ticket that disappears from the world (sprint ends, filter changes) unmounts the board', () => {
  const extension = new JiraOfficeExtension();
  const scene = officeScene();
  extension.start(scene);
  extension.worldChanged(world([ticket('KTP-1')]));
  assert.ok(scene.getObjectByName('jira-board'));

  extension.worldChanged(world([]));
  assert.equal(scene.getObjectByName('jira-board'), undefined);
});

test('the board redraws only when the ticket data actually changes', () => {
  drawn.length = 0;
  const extension = new JiraOfficeExtension();
  const scene = officeScene();
  extension.start(scene);
  extension.worldChanged(world([ticket('KTP-1')]));
  const afterFirst = drawn.length;

  extension.worldChanged(world([ticket('KTP-1')])); // identical data
  assert.equal(drawn.length, afterFirst, 'no redraw when nothing changed');

  extension.worldChanged(world([ticket('KTP-1'), ticket('KTP-2')])); // a real change
  assert.ok(drawn.length > afterFirst, 'a redraw when the tickets change');
});

test('drawJiraBoard shows the key, summary and status of each ticket, truncated to a maximum of 10 rows', () => {
  drawn.length = 0;
  const canvas = dom.window.document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const tickets = Array.from({ length: 14 }, (_, i) => ticket(`KTP-${i + 1}`));
  drawJiraBoard(canvas, tickets);
  assert.ok(drawn.includes('My sprint'));
  for (let i = 1; i <= 10; i++) assert.ok(drawn.includes(`KTP-${i}`), `row ${i} drawn`);
  assert.equal(drawn.includes('KTP-11'), false, 'only the first 10 rows draw');
  assert.ok(drawn.some((text) => text.includes('+4 more')));
});

test('drawJiraBoard draws the assignee (issue #145 review)', () => {
  drawn.length = 0;
  const canvas = dom.window.document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  // A short status leaves room for the assignee to draw in full; the overflow case (a long
  // status, priority and assignee together) is covered separately below.
  drawJiraBoard(canvas, [ticket('KTP-1', { status: 'Open', assignee: 'Gabriel Amyot' })]);
  assert.ok(drawn.some((text) => text.includes('Gabriel Amyot')), 'the assignee is drawn somewhere on the board');
});

test('a long summary truncates on its own; the status stays visible regardless (issue #145 review)', () => {
  drawn.length = 0;
  const canvas = dom.window.document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const longSummary = 'A very long ticket summary that would, if drawn together with the status and priority as one string, push them off the edge of the board entirely';
  drawJiraBoard(canvas, [ticket('KTP-1', { summary: longSummary, status: 'Open' })]);

  assert.ok(drawn.some((text) => text.includes('Open')), 'the status is drawn in full, not swallowed by the long summary');
  // The summary itself is the one thing allowed to truncate.
  assert.equal(drawn.some((text) => text === longSummary), false, 'the full, untruncated summary is not what gets drawn');
  assert.ok(drawn.some((text) => text.includes('…') && text.startsWith('A very long')), 'the summary is cut with an ellipsis');
});

test('a long status, priority and assignee together never cross the canvas edge; status is the last thing cut (issue #145 review)', () => {
  drawn.length = 0;
  const canvas = dom.window.document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const metaMaxWidth = 222; // metaWidth (230) minus the same 8px margin drawJiraBoard applies
  drawJiraBoard(canvas, [ticket('KTP-1', { status: 'In Progress', priority: 'High', assignee: 'Gabriel Amyot' })]);

  const metaLine = drawn.find((text) => text.startsWith('(In Progress)'));
  assert.ok(metaLine, 'the status draws, and leads the metadata line');
  assert.ok(metaLine!.length * 10 <= metaMaxWidth, 'the drawn metadata text never measures past the column it must stay inside');
  // Status is first in the joined string, so `fittedText`'s end-cut reaches the lower-priority
  // priority and assignee segments before it ever touches status: status and priority survive,
  // the ellipsis shows the cut happened at all.
  assert.equal(metaLine!.startsWith('(In Progress) · High'), true, 'status and priority survive in full');
  assert.ok(metaLine!.includes('…'), 'this combination alone is already long enough to need a cut');
});

test('an even longer assignee is the thing that cuts, never the status (issue #145 review)', () => {
  drawn.length = 0;
  const canvas = dom.window.document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const metaMaxWidth = 222;
  drawJiraBoard(canvas, [ticket('KTP-1', { status: 'In Progress', priority: 'High', assignee: 'Gabriel Amyot Longname Extra Words' })]);

  const metaLine = drawn.find((text) => text.startsWith('(In Progress)'));
  assert.ok(metaLine, 'the status still draws');
  assert.ok(metaLine!.length * 10 <= metaMaxWidth, 'the drawn metadata text never measures past the column it must stay inside');
  assert.ok(metaLine!.includes('…'), 'the overlong assignee is the thing that gets cut');
  assert.equal(metaLine!.startsWith('(In Progress) · High'), true, 'status and priority survive in full');
});
