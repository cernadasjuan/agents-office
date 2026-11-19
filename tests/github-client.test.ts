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
const fills: string[] = [];
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: (_target, key) => (key === 'fillText' ? (text: string) => { drawn.push(text); } : () => undefined),
  set: (_target, key, value) => {
    if (key === 'fillStyle') fills.push(String(value));
    return true;
  },
})) as never;
const { StickFigure } = await import('../src/characters/StickFigure.js');
const { GithubOfficeExtension, KANBAN_BOARD_SLOTS } = await import('../plugins/github/client.js');
const { CARD_NEUTRAL_BORDER, VERTICES_PER_CARD } = await import('../plugins/github/cards.js');
const { issueIdsLine, ISSUE_LINE_MAX_CHARACTERS } = await import('../plugins/github/labelIds.js');
const { countDrawCalls } = await import('../src/scene/RenderBudget.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

function agent(id: string, issues?: NonNullable<AgentInfo['extras']>['issues']) {
  const info: AgentInfo = { id, name: id, activity: 'implementing', ...(issues ? { extras: { issues } } : {}) };
  return { info, figure: new StickFigure(id, new THREE.Color(0x4a90d9)), seat: null };
}

type Extension = InstanceType<typeof GithubOfficeExtension>;
type Managed = ReturnType<typeof agent>;

function cardCount(extension: Extension, managed: Managed): number {
  return extension.cards.placements.filter((placement) => placement.agentId === managed.info.id).length;
}

test('an agent wears one card per issue, and the cards follow the issues', () => {
  const extension = new GithubOfficeExtension();
  extension.start(new THREE.Scene());
  const a = agent('a', [{ number: 38, title: 'Board' }, { number: 12, title: '' }, { number: 7, title: 'x' }]);
  const b = agent('b');

  extension.agentsChanged([a, b]);
  assert.equal(cardCount(extension, a), 3);
  assert.equal(cardCount(extension, b), 0);
  assert.ok(drawn.includes('#38') && drawn.includes('#12') && drawn.includes('#7'));

  a.info.extras = { issues: [{ number: 38, title: 'Board' }] };
  extension.agentsChanged([a, b]);
  assert.equal(cardCount(extension, a), 1);

  a.info.extras = undefined;
  extension.agentsChanged([a, b]);
  assert.equal(cardCount(extension, a), 0);
});

test('an agent never wears more than 5 cards, and a removed agent drops its cards', () => {
  const extension = new GithubOfficeExtension();
  extension.start(new THREE.Scene());
  const a = agent('a', Array.from({ length: 9 }, (_, i) => ({ number: i + 1, title: '' })));
  extension.agentsChanged([a]);
  assert.equal(cardCount(extension, a), 5);

  extension.agentsChanged([]);
  assert.equal(cardCount(extension, a), 0);
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

// --- Badges on the shoulders and upper arms, upright and facing the camera (issue #77) ---

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const MAX_DEGREES = 15;
const RENDERER = {} as THREE.WebGLRenderer;

interface Quad { center: THREE.Vector3; normal: THREE.Vector3; up: THREE.Vector3; area: number }

function cardMesh(scene: THREE.Scene): THREE.Mesh {
  const mesh = scene.getObjectByName('github-cards') as THREE.Mesh | undefined;
  assert.ok(mesh, 'the card mesh is in the scene');
  return mesh;
}

function vertex(scene: THREE.Scene, name: 'position' | 'uv', index: number): THREE.Vector3 {
  const attribute = cardMesh(scene).geometry.getAttribute(name);
  return name === 'uv'
    ? new THREE.Vector3(attribute.getX(index), attribute.getY(index), 0)
    : new THREE.Vector3().fromBufferAttribute(attribute, index);
}

/** The front face of card `index`, read from the vertices the renderer draws. */
function frontQuad(scene: THREE.Scene, index: number): Quad {
  const [bl, br, tr, tl] = [0, 1, 2, 3].map((k) => vertex(scene, 'position', index * VERTICES_PER_CARD + k));
  const right = br.clone().sub(bl);
  const up = tl.clone().sub(bl);
  const normal = right.clone().cross(up);
  return { center: bl.clone().add(tr).multiplyScalar(0.5), normal: normal.clone().normalize(), up: up.normalize(), area: normal.length() };
}

/** What the renderer does before it draws: world matrices, then the scene hook with the camera. */
function render(scene: THREE.Scene, camera: THREE.Camera): void {
  scene.updateMatrixWorld();
  camera.updateMatrixWorld();
  scene.onBeforeRender(RENDERER, scene, camera, null as never, null as never, null as never);
}

function wearing(count = 5, rotation = 1.3) {
  const extension = new GithubOfficeExtension();
  const scene = new THREE.Scene();
  extension.start(scene);
  const managed = agent('a', Array.from({ length: count }, (_, i) => ({ number: i + 1, title: '' })));
  scene.add(managed.figure.group);
  managed.figure.group.rotation.y = rotation;
  extension.agentsChanged([managed]);
  return { extension, scene, managed };
}

/** A camera on a circle around the agent: 0 degrees is in front of it, 90 its side, 180 behind it. */
function cameraAround(managed: Managed, degrees: number, height = 1.35, distance = 4): THREE.PerspectiveCamera {
  const body = managed.figure.group;
  body.updateMatrixWorld(true);
  const yaw = body.rotation.y + THREE.MathUtils.degToRad(degrees);
  const at = body.getWorldPosition(new THREE.Vector3());
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(at.x + Math.sin(yaw) * distance, height, at.z + Math.cos(yaw) * distance);
  camera.lookAt(at.x, height, at.z);
  return camera;
}

function degreesBetween(a: THREE.Vector3, b: THREE.Vector3): number {
  return THREE.MathUtils.radToDeg(a.angleTo(b));
}

function worldPoint(object: THREE.Object3D, local = new THREE.Vector3()): THREE.Vector3 {
  return object.localToWorld(local.clone());
}

/** Shortest distance from a point to the segment shoulder-elbow of an upper arm. */
function distanceToUpperArm(point: THREE.Vector3, upperArm: THREE.Object3D): number {
  const segment = new THREE.Line3(worldPoint(upperArm), worldPoint(upperArm, new THREE.Vector3(0, -0.3, 0)));
  return segment.closestPointToPoint(point, true, new THREE.Vector3()).distanceTo(point);
}

function armTiltDegrees(upperArm: THREE.Object3D): number {
  const down = new THREE.Vector3(0, -1, 0).applyQuaternion(upperArm.getWorldQuaternion(new THREE.Quaternion()));
  return degreesBetween(down, WORLD_UP.clone().negate());
}

type Pose = (managed: Managed) => void;
const POSES: Array<[string, Pose, boolean]> = [
  ['typing', (m) => m.figure.setActivity('implementing'), true],
  ['idle', (m) => m.figure.setActivity('idle'), false],
  ['raised hand', (m) => { m.figure.setActivity('implementing'); m.figure.setAttention('waiting', 4); }, true],
  ['walking', (m) => m.figure.moveTo(new THREE.Vector3(200, 0, 140), new THREE.Vector3(200, 0, 150)), true],
];

for (const [name, pose, armMoves] of POSES) {
  test(`while ${name}, every card sits on a shoulder or upper arm, never in a hand, within 15 degrees of upright`, () => {
    const { scene, managed } = wearing();
    pose(managed);
    const { joints } = managed.figure;
    let maxArmTilt = 0;
    for (let t = 0; t < 3; t += 1 / 30) {
      managed.figure.update(t, 1 / 30);
      render(scene, cameraAround(managed, 0));
      maxArmTilt = Math.max(maxArmTilt, armTiltDegrees(joints.rightUpperArm), armTiltDegrees(joints.leftUpperArm));
      for (let index = 0; index < 5; index++) {
        const card = frontQuad(scene, index);
        assert.ok(card.area > 0, `${name}: card ${index} is drawn`);
        const tilt = degreesBetween(card.up, WORLD_UP);
        assert.ok(tilt <= MAX_DEGREES, `${name} t=${t.toFixed(2)}: card ${index} tilts ${tilt.toFixed(1)} degrees`);
        const toArm = Math.min(distanceToUpperArm(card.center, joints.rightUpperArm), distanceToUpperArm(card.center, joints.leftUpperArm));
        // The farthest card is the fifth one stacked up a raised arm, at 0.21: outward and lifted toward the camera
        assert.ok(toArm <= 0.22, `${name}: card ${index} is ${toArm.toFixed(2)} from an upper arm`);
        const toHand = Math.min(worldPoint(joints.rightHand).distanceTo(card.center), worldPoint(joints.leftHand).distanceTo(card.center));
        assert.ok(toHand >= 0.15, `${name}: card ${index} is ${toHand.toFixed(2)} from a hand`);
      }
    }
    // The pose must tilt an arm past the limit, else a card that followed the arm would pass too
    if (armMoves) assert.ok(maxArmTilt > MAX_DEGREES, `${name}: the arms tilt only ${maxArmTilt.toFixed(1)} degrees`);
  });
}

for (const degrees of [0, 90, 180, 270]) {
  test(`with the camera at ${degrees} degrees around a typing agent, every card faces the camera within 15 degrees`, () => {
    const { scene, managed } = wearing();
    managed.figure.setActivity('implementing');
    for (let t = 0; t < 2; t += 1 / 30) managed.figure.update(t, 1 / 30);
    const camera = cameraAround(managed, degrees);
    render(scene, camera);
    for (let index = 0; index < 5; index++) {
      const card = frontQuad(scene, index);
      const toCamera = camera.position.clone().sub(card.center);
      const angle = degreesBetween(card.normal, toCamera);
      assert.ok(angle <= MAX_DEGREES, `card ${index} is ${angle.toFixed(1)} degrees off the camera`);
      assert.ok(degreesBetween(card.up, WORLD_UP) <= MAX_DEGREES);
    }
  });
}

test('the newest issue sits on the shoulder nearest the camera, whatever the side', () => {
  const { extension, scene, managed } = wearing();
  for (const degrees of [90, 270, 90]) {
    const camera = cameraAround(managed, degrees);
    render(scene, camera);
    const view = camera.getWorldDirection(new THREE.Vector3());
    const depths = extension.cards.placements.map((_placement, index) => frontQuad(scene, index).center.sub(camera.position).dot(view));
    const newest = extension.cards.placements.findIndex((placement) => placement.number === 1);
    assert.ok(depths[newest] <= Math.min(...depths) + 0.01, `camera at ${degrees}: a card lies in front of the newest`);
    const farSide = [1, 3].map((slot) => depths[extension.cards.placements.findIndex((placement) => placement.slot === slot)]);
    for (const depth of farSide) assert.ok(depths[newest] < depth - 0.2, `camera at ${degrees}: the newest card is not on the near side`);
  }
});

test('cards on one side never overlap: each one hangs below the previous one', () => {
  const { scene, managed } = wearing();
  managed.figure.setActivity('implementing');
  for (let t = 0; t < 2; t += 1 / 30) managed.figure.update(t, 1 / 30);
  render(scene, cameraAround(managed, 0));
  const heights = [0, 2, 4].map((index) => frontQuad(scene, index).center.y);
  const corners = (index: number) => [0, 3].map((k) => vertex(scene, 'position', index * VERTICES_PER_CARD + k).y);
  for (let row = 1; row < heights.length; row++) {
    const [bottomAbove] = corners([0, 2, 4][row - 1]);
    const [, topBelow] = corners([0, 2, 4][row]);
    assert.ok(topBelow < bottomAbove, `row ${row} overlaps the row above`);
  }
});

test('all cards of 40 agents with 5 issues each cost one draw call and cast no shadow', () => {
  const extension = new GithubOfficeExtension();
  const scene = new THREE.Scene();
  extension.start(scene);
  const agents = Array.from({ length: 40 }, (_, a) => agent(`a${a}`, Array.from({ length: 5 }, (_, i) => ({ number: a * 10 + i + 1, title: '' }))));
  extension.agentsChanged(agents);
  assert.equal(extension.cards.placements.length, 200);
  const calls = countDrawCalls(scene);
  assert.equal(calls.main, 1);
  assert.equal(calls.shadowCasters, 0);
});

test('one geometry holds both faces: the back face reads the right way, without a mirrored DoubleSide', () => {
  const { scene, managed } = wearing(1);
  render(scene, cameraAround(managed, 0));
  const material = cardMesh(scene).material as THREE.MeshBasicMaterial;
  assert.equal(material.side, THREE.FrontSide);
  const mirrorOf = [1, 0, 3, 2];
  for (let k = 0; k < 4; k++) {
    const back = vertex(scene, 'position', 4 + k);
    const front = vertex(scene, 'position', mirrorOf[k]);
    assert.ok(back.distanceTo(front) < 0.01, `back corner ${k} sits on front corner ${mirrorOf[k]}`);
    assert.deepEqual(vertex(scene, 'uv', 4 + k).toArray(), vertex(scene, 'uv', k).toArray(), `back corner ${k} shows the text unmirrored`);
  }
});

test('a hidden figure hides its cards', () => {
  const { scene, managed } = wearing(2);
  managed.figure.group.visible = false;
  render(scene, cameraAround(managed, 0));
  assert.equal(frontQuad(scene, 0).area, 0);
  assert.equal(frontQuad(scene, 1).area, 0);
});

test('a card reads <repo>#N when the repository is known, and #N without it', () => {
  const extension = new GithubOfficeExtension();
  extension.start(new THREE.Scene());
  drawn.length = 0;
  extension.agentsChanged([agent('a', [{ number: 77, title: '', repo: 'ao' }, { number: 12, title: '' }])]);
  assert.ok(drawn.includes('ao#77'), `drawn: ${drawn.join(' | ')}`);
  assert.ok(drawn.includes('#12'));

  drawn.length = 0;
  extension.agentsChanged([agent('b', [{ number: 77, title: '', repo: 'agents-office-bench1' }])]);
  assert.ok(drawn.includes('agents-office-bench1') && drawn.includes('#77'), `long names wrap: ${drawn.join(' | ')}`);
});

test('the border takes the issue label color, or a neutral color without one', () => {
  const extension = new GithubOfficeExtension();
  extension.start(new THREE.Scene());
  fills.length = 0;
  extension.agentsChanged([agent('a', [{ number: 1, title: '', color: '0e8a16' }])]);
  assert.ok(fills.includes('#0e8a16'), `fills: ${fills.join(' ')}`);
  assert.equal(fills.includes(CARD_NEUTRAL_BORDER), false);

  fills.length = 0;
  extension.agentsChanged([agent('b', [{ number: 2, title: '' }])]);
  assert.ok(fills.includes(CARD_NEUTRAL_BORDER), `fills: ${fills.join(' ')}`);

  fills.length = 0;
  extension.agentsChanged([agent('c', [{ number: 3, title: '', color: 'red;x' }])]);
  assert.ok(fills.includes(CARD_NEUTRAL_BORDER), 'a color that is not 6-hex falls back to neutral');
  assert.equal(fills.some((fill) => fill.includes('red')), false);
});

test('markup in a repository name stays text on the card canvas', () => {
  const extension = new GithubOfficeExtension();
  extension.start(new THREE.Scene());
  drawn.length = 0;
  extension.agentsChanged([agent('a', [{ number: 3, title: '<b>x</b>', repo: '<img>' }])]);
  assert.ok(drawn.some((text) => text.includes('<img>')), 'drawn as plain text through fillText');
  assert.equal(document.body.innerHTML, '');
});

// --- Issue IDs in the floating label, readable from the overview (issue #77) ---

const issue = (number: number, repo?: string) => ({ number, title: '', ...(repo ? { repo } : {}) });

test('the IDs line names a shared repository once and keeps the newest first', () => {
  assert.equal(issueIdsLine([issue(77, 'agents-office'), issue(79, 'agents-office')]), 'agents-office#77 · #79');
  assert.equal(issueIdsLine([issue(12), issue(4)]), '#12 · #4');
  assert.equal(issueIdsLine([issue(77, 'agents-office'), issue(4), issue(3, 'wb')]), 'agents-office#77 · #4 · wb#3');
  assert.equal(issueIdsLine([]), '');
});

test('the IDs line shows at most 5 IDs and cuts whole IDs when long', () => {
  const many = Array.from({ length: 7 }, (_, i) => issue(i + 1, 'ao'));
  assert.equal(issueIdsLine(many), 'ao#1 · #2 · #3 · #4 · #5');
  const long = [issue(1, 'a'.repeat(30)), issue(2, 'b'.repeat(30)), issue(3, 'c'.repeat(30))];
  const line = issueIdsLine(long);
  assert.equal(line, `${'a'.repeat(30)}#1 +2`, 'whole IDs only, then the count of the rest');
  const cut = issueIdsLine([issue(82, 'agents-office'), issue(98, 'agents-office'), issue(75, 'agents-office'), issue(92, 'agents-office'), issue(76, 'agents-office')]);
  assert.ok(cut.length <= ISSUE_LINE_MAX_CHARACTERS, cut);
  assert.ok(line.startsWith(`${'a'.repeat(30)}#1`), line);
  assert.equal(issueIdsLine([issue(82, 'agents-office'), issue(98, 'agents-office'), issue(75, 'agents-office'), issue(92, 'agents-office'), issue(76, 'agents-office')]),
    'agents-office#82 · #98 · #75 +2');
  const first = issueIdsLine([issue(1, 'x'.repeat(40)), issue(2)]);
  assert.equal(first, `${'x'.repeat(40)}#1 +1`, 'the first ID stays whole even when long');
});

function idsLine(managed: Managed): HTMLElement[] {
  return [...managed.figure.label.element.querySelectorAll<HTMLElement>('.github-issues')];
}

test('the floating label gets one IDs line, through textContent, and loses it with the issues', () => {
  const extension = new GithubOfficeExtension();
  extension.start(new THREE.Scene());
  const a = agent('a', [issue(77, 'agents-office'), { number: 79, title: '<img src=x>', repo: 'agents-office' }]);
  extension.agentsChanged([a]);
  assert.equal(idsLine(a).length, 1);
  assert.equal(idsLine(a)[0].textContent, 'agents-office#77 · #79');
  assert.equal(idsLine(a)[0].children.length, 0, 'plain text, no markup');

  // The core rewrites the label on a new activity; the next poll puts the line back once
  a.figure.setActivity('testing');
  extension.agentsChanged([a]);
  assert.equal(idsLine(a).length, 1);

  a.info.extras = undefined;
  extension.agentsChanged([a]);
  assert.equal(idsLine(a).length, 0);
});

test('compact labels keep the IDs line, so the overview shows the IDs', () => {
  const extension = new GithubOfficeExtension();
  extension.start(new THREE.Scene());
  const style = [...document.head.querySelectorAll('style')].map((element) => element.textContent ?? '').join('\n');
  assert.ok(style.includes('.agent-label.compact .github-issues'), 'a compact rule exists');
  const compactRule = style.slice(style.indexOf('.agent-label.compact .github-issues'));
  assert.equal(compactRule.slice(0, compactRule.indexOf('}')).includes('display: none'), false);
  extension.start(new THREE.Scene());
  assert.equal(document.head.querySelectorAll('style#github-issue-ids').length, 1, 'one style element');
});
