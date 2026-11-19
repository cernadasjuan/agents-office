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

// --- Upright, readable cards (issue #77) ---

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const MAX_TILT_DEGREES = 15;

function heldCards(managed: ReturnType<typeof agent>): THREE.Object3D[] {
  return managed.figure.joints.rightHand.getObjectByName('github-cards')?.children ?? [];
}

function settle(extension: InstanceType<typeof GithubOfficeExtension>, managed: ReturnType<typeof agent>, seconds = 3): void {
  for (let t = 0; t < seconds; t += 1 / 60) {
    managed.figure.update(t, 1 / 60);
    extension.update();
  }
  managed.figure.group.updateMatrixWorld(true);
}

function tiltDegrees(card: THREE.Object3D): number {
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(card.getWorldQuaternion(new THREE.Quaternion()));
  return THREE.MathUtils.radToDeg(up.angleTo(WORLD_UP));
}

function facesAwayFromBody(card: THREE.Object3D, managed: ReturnType<typeof agent>): boolean {
  const face = new THREE.Vector3(0, 0, 1).applyQuaternion(card.getWorldQuaternion(new THREE.Quaternion()));
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(managed.figure.group.getWorldQuaternion(new THREE.Quaternion()));
  return face.dot(forward) > 0.5;
}

type Pose = (managed: ReturnType<typeof agent>) => void;
const POSES: Array<[string, Pose]> = [
  ['typing', (m) => m.figure.setActivity('implementing')],
  ['idle', (m) => m.figure.setActivity('idle')],
  ['raised hand', (m) => { m.figure.setActivity('implementing'); m.figure.setAttention('waiting', 4); }],
  ['walking', (m) => m.figure.moveTo(new THREE.Vector3(200, 0, 140), new THREE.Vector3(200, 0, 150))],
];

for (const [name, pose] of POSES) {
  test(`every held card stays within 15 degrees of upright and faces out while ${name}`, () => {
    const extension = new GithubOfficeExtension();
    const scene = new THREE.Scene();
    extension.start(scene);
    const managed = agent('a', Array.from({ length: 5 }, (_, i) => ({ number: i + 1, title: '' })));
    scene.add(managed.figure.group);
    managed.figure.group.rotation.y = 1.3;
    pose(managed);
    extension.agentsChanged([managed]);
    settle(extension, managed);

    const cards = heldCards(managed);
    assert.equal(cards.length, 5);
    for (const card of cards) {
      assert.ok(tiltDegrees(card) <= MAX_TILT_DEGREES, `${name}: card tilts ${tiltDegrees(card).toFixed(1)} degrees`);
      assert.ok(facesAwayFromBody(card, managed), `${name}: card faces the body`);
    }
  });
}

test('a card reads the same from the back: the back face has its own unmirrored text', () => {
  const extension = new GithubOfficeExtension();
  extension.start(new THREE.Scene());
  const managed = agent('a', [{ number: 9, title: '' }]);
  extension.agentsChanged([managed]);
  const [card] = heldCards(managed) as THREE.Mesh[];
  const material = card.material as THREE.MeshBasicMaterial;
  assert.equal(material.side, THREE.FrontSide, 'no mirrored back side');
  const back = card.children.find((child) => child.name === 'github-card-back') as THREE.Mesh | undefined;
  assert.ok(back, 'card has a back face');
  assert.equal((back.material as THREE.MeshBasicMaterial).side, THREE.FrontSide);
  assert.ok(Math.abs(Math.abs(back.rotation.y) - Math.PI) < 1e-6, 'back face turns to the other side');
});

test('a card reads <repo>#N when the repository is known, and #N without it', () => {
  const extension = new GithubOfficeExtension();
  extension.start(new THREE.Scene());
  drawn.length = 0;
  extension.agentsChanged([agent('a', [{ number: 77, title: '', repo: 'ao' }, { number: 12, title: '' }])]);
  assert.ok(drawn.includes('ao#77'), `drawn: ${drawn.join(' | ')}`);
  assert.ok(drawn.includes('#12'));

  drawn.length = 0;
  extension.agentsChanged([agent('b', [{ number: 77, title: '', repo: 'workbench1' }])]);
  assert.ok(drawn.includes('workbench1') && drawn.includes('#77'), `long names wrap: ${drawn.join(' | ')}`);
});

test('markup in a repository name stays text on the card canvas', () => {
  const extension = new GithubOfficeExtension();
  extension.start(new THREE.Scene());
  drawn.length = 0;
  extension.agentsChanged([agent('a', [{ number: 3, title: '<b>x</b>', repo: '<img>' }])]);
  assert.ok(drawn.some((text) => text.includes('<img>')), 'drawn as plain text through fillText');
  assert.equal(document.body.innerHTML, '');
});
