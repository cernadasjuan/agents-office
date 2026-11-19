import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { AgentInfo } from '../src/agents/AgentData.js';
import type { World } from '../src/extensions.js';

// Toon materials and canvas textures need a document and a 2D context stub.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
const drawn: string[] = [];
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: (_target, key) => (key === 'fillText' ? (text: string) => { drawn.push(text); } : () => undefined),
  set: () => true,
})) as never;
const { StickFigure } = await import('../src/characters/StickFigure.js');
const { GithubOfficeExtension, KANBAN_BOARD_SLOTS } = await import('../plugins/github/client.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

function agent(id: string, issues?: NonNullable<AgentInfo['extras']>['issues']) {
  const info: AgentInfo = { id, name: id, activity: 'implementing', ...(issues ? { extras: { issues } } : {}) };
  return { info, figure: new StickFigure(id, new THREE.Color(0x4a90d9)), seat: null };
}

function cardCount(managed: ReturnType<typeof agent>): number {
  return managed.figure.joints.rightHand.getObjectByName('github-cards')?.children.length ?? 0;
}

test('an agent holds one card per issue, and the cards follow the issues', () => {
  const extension = new GithubOfficeExtension();
  extension.start(new THREE.Scene());
  const a = agent('a', [{ number: 38, title: 'Board' }, { number: 12, title: '' }, { number: 7, title: 'x' }]);
  const b = agent('b');

  extension.agentsChanged([a, b]);
  assert.equal(cardCount(a), 3);
  assert.equal(cardCount(b), 0);
  assert.ok(drawn.includes('#38') && drawn.includes('#12') && drawn.includes('#7'));

  a.info.extras = { issues: [{ number: 38, title: 'Board' }] };
  extension.agentsChanged([a, b]);
  assert.equal(cardCount(a), 1);

  a.info.extras = undefined;
  extension.agentsChanged([a, b]);
  assert.equal(cardCount(a), 0);
});

test('an agent never holds more than 5 cards, and a removed agent drops its cards', () => {
  const extension = new GithubOfficeExtension();
  extension.start(new THREE.Scene());
  const a = agent('a', Array.from({ length: 9 }, (_, i) => ({ number: i + 1, title: '' })));
  extension.agentsChanged([a]);
  assert.equal(cardCount(a), 5);

  extension.agentsChanged([]);
  assert.equal(cardCount(a), 0);
});

const world = (boards: World['boards']): World => ({ plugins: ['github'], rooms: [], boards });
const board = (title: string) => ({ id: `id-${title}`, title, columns: [
  { name: 'To do', cards: [{ number: 1, title: 'First' }] },
  { name: 'In progress', cards: [{ number: 38, title: 'Kanban' }] },
  { name: 'Done', cards: [] },
] });

test('each board hangs on the wall as a framed canvas, redrawn only when its data changes', () => {
  const scene = new THREE.Scene();
  const extension = new GithubOfficeExtension();
  extension.start(scene);
  const boards = () => scene.children.filter((child) => child.name === 'github-kanban');

  extension.worldChanged(world([]));
  assert.equal(boards().length, 0);

  drawn.length = 0;
  extension.worldChanged(world([board('o/r')]));
  assert.equal(boards().length, 1);
  assert.deepEqual(boards()[0].position.toArray(), KANBAN_BOARD_SLOTS[0].position);
  assert.ok(drawn.includes('o/r') && drawn.includes('To do (1)') && drawn.includes('In progress (1)'));
  assert.ok(drawn.some((text) => text.startsWith('#38')));

  drawn.length = 0;
  extension.worldChanged(world([board('o/r')]));
  assert.equal(drawn.length, 0);

  extension.worldChanged(world([board('o/r'), board('o/s')]));
  assert.equal(boards().length, 2);

  extension.worldChanged(world([]));
  assert.equal(boards().length, 0);
});
