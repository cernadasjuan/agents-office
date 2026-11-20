import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import {
  FIRST_PERSON_FULL_LABEL_DISTANCE,
  LABEL_DETAIL_INTERVAL_MS,
  LabelDetailController,
  OVERVIEW_FULL_LABEL_ZOOM,
  applyLabelDetail,
  labelDetail,
  nextLabelMode,
  parseLabelMode,
  type LabelAgent,
  type LabelFacts,
  type LabelView,
} from '../src/ui/LabelDetail.js';

const dom = new JSDOM('<!doctype html><html><body><div id="label-mode"></div></body></html>');
after(() => dom.window.close());

const near = FIRST_PERSON_FULL_LABEL_DISTANCE - 1;
const far = FIRST_PERSON_FULL_LABEL_DISTANCE + 1;
const zoomedIn = OVERVIEW_FULL_LABEL_ZOOM - 1;
const zoomedOut = OVERVIEW_FULL_LABEL_ZOOM + 10;

function facts(overrides: Partial<LabelFacts> = {}): LabelFacts {
  return { attention: undefined, selected: false, hovered: false, distance: far, ...overrides };
}

function view(overrides: Partial<LabelView> = {}): LabelView {
  return { mode: 'smart', viewMode: 'first-person', zoomDistance: zoomedOut, ...overrides };
}

// --- Pure decision ---

test('smart mode, first person: a far agent with nothing special gets a compact label', () => {
  assert.equal(labelDetail(facts(), view()), 'compact');
});

test('smart mode, first person: an agent within the near distance gets a full label', () => {
  assert.equal(labelDetail(facts({ distance: near }), view()), 'full');
  assert.equal(labelDetail(facts({ distance: FIRST_PERSON_FULL_LABEL_DISTANCE }), view()), 'full');
});

test('smart mode: a waiting agent without a known wait time always gets a full label (the old behavior), in both views and at any zoom', () => {
  const waiting = facts({ attention: 'waiting', distance: 500 });
  assert.equal(labelDetail(waiting, view()), 'full');
  assert.equal(labelDetail(waiting, view({ viewMode: 'isometric', zoomDistance: zoomedOut })), 'full');
});

test('smart mode: a fresh wait always gets a full label, in both views and at any zoom (#132)', () => {
  const fresh = facts({ attention: 'waiting', waitMinutes: 5, distance: 500 });
  assert.equal(labelDetail(fresh, view()), 'full');
  assert.equal(labelDetail(fresh, view({ viewMode: 'isometric', zoomDistance: zoomedOut })), 'full');
});

test('smart mode: a cold block (waiting 24 h or more) gets a compact label like any other agent', () => {
  const coldBlock = facts({ attention: 'waiting', waitMinutes: 2 * 24 * 60, distance: 500 });
  assert.equal(labelDetail(coldBlock, view()), 'compact');
  assert.equal(labelDetail(coldBlock, view({ viewMode: 'isometric', zoomDistance: zoomedOut })), 'compact');
});

test('smart mode, isometric: an aging block follows the normal zoom rule, not forced full (#132)', () => {
  const agingFar = facts({ attention: 'waiting', waitMinutes: 60, distance: 500 });
  assert.equal(labelDetail(agingFar, view({ viewMode: 'isometric', zoomDistance: zoomedOut })), 'compact', 'zoomed out: compact, same as a real queue at scale');
  assert.equal(labelDetail(facts({ attention: 'waiting', waitMinutes: 60, distance: 500 }), view({ viewMode: 'isometric', zoomDistance: zoomedIn })), 'full', 'zoomed in: full, like any other agent');
});

test('smart mode, first person: an aging block still forces a full label, unchanged from before #132', () => {
  // The issue #132 fixed described overview crowding only. First person's own
  // queue spacing can already overlap on screen; an aging wait nearby must not
  // lose its activity line (review fix: https://github.com/gabriel-amyot/agents-office/pull/152).
  const agingFar = facts({ attention: 'waiting', waitMinutes: 60, distance: 500 });
  assert.equal(labelDetail(agingFar, view()), 'full', 'far in first person: still full, the original rule');
  const agingNear = facts({ attention: 'waiting', waitMinutes: 60, distance: near });
  assert.equal(labelDetail(agingNear, view()), 'full', 'still full up close too');
});

test('smart mode: "your turn" alone does not make a label full (most idle sessions have it)', () => {
  assert.equal(labelDetail(facts({ attention: 'your-turn' }), view()), 'compact');
  assert.equal(labelDetail(facts({ attention: 'your-turn' }), view({ viewMode: 'isometric' })), 'compact');
});

test('smart mode: the selected agent gets a full label in both views', () => {
  assert.equal(labelDetail(facts({ selected: true }), view()), 'full');
  assert.equal(labelDetail(facts({ selected: true }), view({ viewMode: 'isometric' })), 'full');
});

test('smart mode: the hovered agent gets a full label in both views', () => {
  assert.equal(labelDetail(facts({ hovered: true }), view()), 'full');
  assert.equal(labelDetail(facts({ hovered: true }), view({ viewMode: 'isometric' })), 'full');
});

test('smart mode, isometric: far zoom gives compact labels, even for agents near the camera', () => {
  assert.equal(labelDetail(facts({ distance: near }), view({ viewMode: 'isometric', zoomDistance: zoomedOut })), 'compact');
});

test('smart mode, isometric: close zoom gives full labels', () => {
  assert.equal(labelDetail(facts(), view({ viewMode: 'isometric', zoomDistance: zoomedIn })), 'full');
  assert.equal(labelDetail(facts(), view({ viewMode: 'isometric', zoomDistance: OVERVIEW_FULL_LABEL_ZOOM })), 'full');
});

test('smart mode, first person: the isometric zoom has no effect', () => {
  assert.equal(labelDetail(facts(), view({ zoomDistance: zoomedIn })), 'compact');
});

test('all mode: every label is full, whatever the facts', () => {
  for (const viewMode of ['first-person', 'isometric'] as const) {
    for (const zoomDistance of [zoomedIn, zoomedOut]) {
      for (const distance of [near, far, 1000]) {
        assert.equal(labelDetail(facts({ distance }), view({ mode: 'all', viewMode, zoomDistance })), 'full');
      }
    }
  }
});

test('an unknown distance (NaN) counts as far, never as near', () => {
  assert.equal(labelDetail(facts({ distance: Number.NaN }), view()), 'compact');
});

test('smart mode: a stuck agent always gets a full label, in both views and at any zoom, even unselected and unhovered', () => {
  const stuck = facts({ stuck: true, distance: 500 });
  assert.equal(labelDetail(stuck, view()), 'full');
  assert.equal(labelDetail(stuck, view({ viewMode: 'isometric', zoomDistance: zoomedOut })), 'full');
});

test('a recovered (no longer stuck) far agent goes back to a compact label', () => {
  assert.equal(labelDetail(facts({ stuck: false, distance: far }), view()), 'compact');
});

// --- URL hash and key cycle ---

test('#labels=all selects all labels, everything else gives the smart default', () => {
  assert.equal(parseLabelMode(''), 'smart');
  assert.equal(parseLabelMode('#labels=all'), 'all');
  assert.equal(parseLabelMode('#view=iso&labels=all'), 'all');
  assert.equal(parseLabelMode('labels=all'), 'all');
  assert.equal(parseLabelMode('#labels=smart'), 'smart');
  assert.equal(parseLabelMode('#labels=ALL<script>'), 'smart');
  assert.equal(parseLabelMode('#view=iso'), 'smart');
});

test('the V cycle goes smart, all, smart', () => {
  assert.equal(nextLabelMode('smart'), 'all');
  assert.equal(nextLabelMode('all'), 'smart');
});

// --- DOM class toggle ---

function labelElement(): HTMLElement {
  const element = dom.window.document.createElement('div');
  element.className = 'agent-label';
  const name = dom.window.document.createElement('div');
  name.className = 'name';
  name.textContent = 'worker';
  const activity = dom.window.document.createElement('div');
  activity.className = 'activity';
  activity.textContent = 'Implementing · codex';
  element.append(name, activity);
  return element;
}

test('applyLabelDetail toggles only the compact class and keeps the label content', () => {
  const element = labelElement();
  const name = element.querySelector('.name');
  const activity = element.querySelector('.activity');

  assert.equal(applyLabelDetail(element, 'compact'), true);
  assert.equal(element.classList.contains('compact'), true);
  assert.equal(element.classList.contains('agent-label'), true);
  assert.equal(element.querySelector('.name'), name);
  assert.equal(element.querySelector('.activity'), activity);
  assert.equal(activity?.textContent, 'Implementing · codex');

  assert.equal(applyLabelDetail(element, 'compact'), false, 'no DOM write when nothing changes');
  assert.equal(applyLabelDetail(element, 'full'), true);
  assert.equal(element.classList.contains('compact'), false);
  assert.equal(applyLabelDetail(element, 'full'), false);
});

// --- Controller ---

function agent(id: string, x: number, attention?: 'waiting' | 'your-turn', stuck?: boolean, waitMinutes?: number, activity = 'implementing'): LabelAgent {
  const group = new THREE.Group();
  group.position.set(x, 0, 0);
  // A real child object, like the real label offset from the figure (Label.ts, createLabel): getWorldPosition works the same way.
  const label = new THREE.Object3D();
  label.position.set(0, 2.1, 0);
  group.add(label);
  const extras = attention || stuck || waitMinutes !== undefined
    ? { ...(attention ? { attention } : {}), ...(stuck ? { stuck } : {}), ...(waitMinutes !== undefined ? { waitMinutes } : {}) }
    : undefined;
  return {
    info: { id, activity, extras },
    figure: { group, label: Object.assign(label, { element: labelElement() }) },
  };
}

function controllerSetup(options: { hash?: string; viewMode?: 'first-person' | 'isometric'; zoom?: number } = {}) {
  const document = dom.window.document;
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 0);
  const agents = [agent('near', 3), agent('far', 30), agent('blocked', 40, 'waiting'), agent('mine', 50, 'your-turn')];
  const state = { viewMode: options.viewMode ?? 'first-person', zoom: options.zoom ?? zoomedOut, selected: null as string | null, picked: null as string | null };
  const indicator = document.getElementById('label-mode');
  const controller = new LabelDetailController({
    agents: () => agents,
    camera,
    canvas,
    keys: dom.window,
    viewMode: () => state.viewMode,
    zoomDistance: () => state.zoom,
    pick: () => state.picked,
    selected: () => state.selected,
    hash: options.hash,
    indicator,
  });
  const compact = () => agents.filter((a) => a.figure.label.element.classList.contains('compact')).map((a) => a.info.id);
  const press = (code: string, target?: Element) => {
    const event = new dom.window.KeyboardEvent('keydown', { code, key: code, bubbles: true });
    if (target) target.dispatchEvent(event);
    else dom.window.dispatchEvent(event);
  };
  return { controller, agents, state, compact, press, indicator, canvas };
}

test('controller, smart default in first person: only far agents with nothing special are compact', () => {
  const { controller, compact, indicator } = controllerSetup();
  assert.equal(controller.mode, 'smart');
  controller.update(0);
  assert.deepEqual(compact(), ['far', 'mine']);
  assert.equal(indicator?.textContent, 'Labels: smart (V)');
});

test('controller: the selected and the hovered agents become full', () => {
  const { controller, state, compact, canvas } = controllerSetup();
  state.picked = 'mine';
  controller.update(0);
  assert.deepEqual(compact(), ['far', 'mine'], 'no pointer over the canvas yet: nothing is hovered');
  state.selected = 'far';
  canvas.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 10, clientY: 10 }));
  controller.refresh();
  assert.deepEqual(compact(), []);
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerleave'));
  controller.refresh();
  assert.deepEqual(compact(), ['mine'], 'the pointer left: the hover ends');
});

test('controller, isometric: far zoom compacts all but the waiting agent, close zoom shows all full', () => {
  const { controller, state, compact } = controllerSetup({ viewMode: 'isometric' });
  controller.update(0);
  assert.deepEqual(compact(), ['near', 'far', 'mine']);
  state.zoom = zoomedIn;
  controller.update(LABEL_DETAIL_INTERVAL_MS);
  assert.deepEqual(compact(), []);
});

test('controller: updates are throttled, a forced refresh is not', () => {
  const { controller, state, compact } = controllerSetup({ viewMode: 'isometric' });
  controller.update(1000);
  state.zoom = zoomedIn;
  controller.update(1000 + LABEL_DETAIL_INTERVAL_MS - 1);
  assert.deepEqual(compact(), ['near', 'far', 'mine'], 'too soon: nothing recomputed');
  controller.update(1000 + LABEL_DETAIL_INTERVAL_MS);
  assert.deepEqual(compact(), []);
});

test('controller: #labels=all keeps every label full (the old behavior)', () => {
  const { controller, compact, indicator } = controllerSetup({ hash: '#view=iso&labels=all', viewMode: 'isometric' });
  assert.equal(controller.mode, 'all');
  controller.update(0);
  assert.deepEqual(compact(), []);
  assert.equal(indicator?.textContent, 'Labels: all (V)');
});

test('controller: key V cycles smart, all, smart and applies at once', () => {
  const { controller, compact, press, indicator } = controllerSetup();
  controller.update(0);
  press('KeyV');
  assert.equal(controller.mode, 'all');
  assert.deepEqual(compact(), []);
  assert.equal(indicator?.textContent, 'Labels: all (V)');
  press('KeyV');
  assert.equal(controller.mode, 'smart');
  assert.deepEqual(compact(), ['far', 'mine']);
});

test('controller: key V in a form field does not change the mode', () => {
  const { controller, press } = controllerSetup();
  const input = dom.window.document.createElement('input');
  dom.window.document.body.appendChild(input);
  press('KeyV', input);
  assert.equal(controller.mode, 'smart');
});

test('controller: an agent without extras (no attention data) follows the distance rule only', () => {
  const { controller, agents, compact } = controllerSetup();
  agents.push(agent('plain-near', 2), agent('plain-far', 99));
  controller.update(0);
  assert.deepEqual(compact(), ['far', 'mine', 'plain-far']);
});

test('controller: a stuck agent far from the camera, unselected and unhovered, still gets a full label', () => {
  const { controller, agents, compact } = controllerSetup();
  agents.push(agent('stuck-far', 99, undefined, true));
  controller.update(0);
  assert.deepEqual(compact(), ['far', 'mine'], 'stuck-far is absent from the compact list');
});

// --- Declutter integration (#132): the real-scale queue overlap ---

function hiddenIds(agents: LabelAgent[]): string[] {
  return agents.filter((a) => a.figure.label.element.style.visibility === 'hidden').map((a) => a.info.id);
}

function declutterSetup(options: { hash?: string; viewMode?: 'first-person' | 'isometric'; zoom?: number } = {}) {
  const document = dom.window.document;
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  // jsdom never computes real layout; stub the canvas size so the controller can project a screen point.
  canvas.getBoundingClientRect = () => ({ width: 1600, height: 1000, left: 0, top: 0, right: 1600, bottom: 1000, x: 0, y: 0, toJSON: () => ({}) });
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 200);
  camera.position.set(0, 1, 30);
  camera.lookAt(0, 1, 0);
  camera.updateMatrixWorld();
  const agents: LabelAgent[] = [];
  const state = { viewMode: options.viewMode ?? 'isometric', zoom: options.zoom ?? 0, selected: null as string | null, picked: null as string | null };
  const controller = new LabelDetailController({
    agents: () => agents,
    camera,
    canvas,
    keys: dom.window,
    viewMode: () => state.viewMode,
    zoomDistance: () => state.zoom,
    pick: () => state.picked,
    selected: () => state.selected,
    hash: options.hash,
  });
  return { controller, agents, state, canvas, camera };
}

test('declutter: a waiting agent overlapping a plain working one keeps the wait visible, hides the other', () => {
  const { controller, agents } = declutterSetup();
  agents.push(agent('working', 0, undefined, false, undefined, 'implementing'));
  agents.push(agent('aging-wait', 0, 'waiting', false, 60));
  controller.update(0);
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), ['working'], 'the aging wait outranks a plain working agent and stays visible');
});

test('declutter: a selected agent overlapping a fresh wait still wins (selected outranks everything)', () => {
  const { controller, agents, state } = declutterSetup();
  agents.push(agent('fresh-wait', 0, 'waiting', false, 5));
  agents.push(agent('picked', 0));
  state.selected = 'picked';
  controller.update(0);
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), ['fresh-wait']);
});

test('declutter: an agent with a clear screen spot of its own is never hidden, whatever its priority', () => {
  const { controller, agents } = declutterSetup();
  agents.push(agent('here', 0, undefined, false, undefined, 'idle'));
  agents.push(agent('far-away', -8, undefined, false, undefined, 'implementing'));
  controller.update(0);
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), [], 'the two project to different screen points: no overlap, nothing hides');
});

test('declutter: #labels=all shows every label, even ones that would otherwise overlap', () => {
  const { controller, agents, state } = declutterSetup({ hash: '#labels=all' });
  agents.push(agent('a', 0), agent('b', 0));
  state.viewMode = 'isometric';
  controller.update(0);
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), []);
});

// --- Review fix round (PR #152): view-mode guard, real label size, behind-camera skip ---

test('declutter: never runs in first person, even for labels that would overlap in the isometric view (review fix)', () => {
  const { controller, agents, state } = declutterSetup({ viewMode: 'first-person' });
  agents.push(agent('working', 0), agent('aging-wait', 0, 'waiting', false, 60));
  controller.update(0);
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), [], 'same screen spot, but first person never hides a label');
  state.viewMode = 'isometric';
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), ['working'], 'the same two agents do decide an overlap once in the overview');
});

test('declutter: runs in the isometric view too (review fix)', () => {
  const { controller, agents } = declutterSetup({ viewMode: 'isometric' });
  agents.push(agent('working', 0), agent('aging-wait', 0, 'waiting', false, 60));
  controller.update(0);
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), ['working']);
});

test('declutter: a long name\'s real rendered width can overlap a neighbor the fixed estimate alone would miss (review fix)', () => {
  // Zoomed out, so labels go compact (zoom <= OVERVIEW_FULL_LABEL_ZOOM would force full and
  // use FULL_LABEL_SIZE instead): x=0 and x=4 project about 115 px apart here, just past the
  // sum of two compact half-widths (55+55=110).
  const { controller, agents } = declutterSetup({ zoom: zoomedOut });
  agents.push(agent('working', 0), agent('long-name-idle', 4, undefined, false, undefined, 'idle'));
  controller.update(0);
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), [], 'with the fixed compact-size estimate alone, these two do not overlap');

  agents[1].figure.label.element.getBoundingClientRect = () => (
    { width: 300, height: 24, left: 0, top: 0, right: 300, bottom: 24, x: 0, y: 0, toJSON: () => ({}) }
  );
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), ['long-name-idle'], 'the real, wider box now overlaps "working" and the lower-priority idle one hides');
});

test('declutter: an agent behind the camera is never a candidate, so it cannot wrongly outrank an on-screen label (review fix)', () => {
  const { controller, agents } = declutterSetup();
  // Behind the camera along its own view direction: it looks toward -z from z=30, so z=60 sits past it.
  const behind = agent('behind-camera', 0, 'waiting', false, 1);
  behind.figure.group.position.set(0, 0, 60);
  agents.push(agent('plain', 0), behind);
  controller.update(0);
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), ['behind-camera'], 'never drawn on screen anyway, so its own label hides; "plain" is never hidden by it');
});
