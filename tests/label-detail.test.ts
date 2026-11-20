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

test('smart mode: a waiting (blocked) agent always gets a full label, in both views and at any zoom', () => {
  const waiting = facts({ attention: 'waiting', distance: 500 });
  assert.equal(labelDetail(waiting, view()), 'full');
  assert.equal(labelDetail(waiting, view({ viewMode: 'overview', zoomDistance: zoomedOut })), 'full');
});

test('smart mode: a cold block (waiting 24 h or more) gets a compact label like any other agent', () => {
  const coldBlock = facts({ attention: 'waiting', waitMinutes: 2 * 24 * 60, distance: 500 });
  assert.equal(labelDetail(coldBlock, view()), 'compact');
  assert.equal(labelDetail(coldBlock, view({ viewMode: 'overview', zoomDistance: zoomedOut })), 'compact');
  assert.equal(labelDetail(facts({ attention: 'waiting', waitMinutes: 60, distance: 500 }), view()), 'full', 'an aging block stays full');
});

test('smart mode: "your turn" alone does not make a label full (most idle sessions have it)', () => {
  assert.equal(labelDetail(facts({ attention: 'your-turn' }), view()), 'compact');
  assert.equal(labelDetail(facts({ attention: 'your-turn' }), view({ viewMode: 'overview' })), 'compact');
});

test('smart mode: the selected agent gets a full label in both views', () => {
  assert.equal(labelDetail(facts({ selected: true }), view()), 'full');
  assert.equal(labelDetail(facts({ selected: true }), view({ viewMode: 'overview' })), 'full');
});

test('smart mode: the hovered agent gets a full label in both views', () => {
  assert.equal(labelDetail(facts({ hovered: true }), view()), 'full');
  assert.equal(labelDetail(facts({ hovered: true }), view({ viewMode: 'overview' })), 'full');
});

test('smart mode, overview: far zoom gives compact labels, even for agents near the camera', () => {
  assert.equal(labelDetail(facts({ distance: near }), view({ viewMode: 'overview', zoomDistance: zoomedOut })), 'compact');
});

test('smart mode, overview: close zoom gives full labels', () => {
  assert.equal(labelDetail(facts(), view({ viewMode: 'overview', zoomDistance: zoomedIn })), 'full');
  assert.equal(labelDetail(facts(), view({ viewMode: 'overview', zoomDistance: OVERVIEW_FULL_LABEL_ZOOM })), 'full');
});

test('smart mode, first person: the overview zoom has no effect', () => {
  assert.equal(labelDetail(facts(), view({ zoomDistance: zoomedIn })), 'compact');
});

test('all mode: every label is full, whatever the facts', () => {
  for (const viewMode of ['first-person', 'overview'] as const) {
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
  assert.equal(labelDetail(stuck, view({ viewMode: 'overview', zoomDistance: zoomedOut })), 'full');
});

test('a recovered (no longer stuck) far agent goes back to a compact label', () => {
  assert.equal(labelDetail(facts({ stuck: false, distance: far }), view()), 'compact');
});

// --- URL hash and key cycle ---

test('#labels=all selects all labels, everything else gives the smart default', () => {
  assert.equal(parseLabelMode(''), 'smart');
  assert.equal(parseLabelMode('#labels=all'), 'all');
  assert.equal(parseLabelMode('#view=overview&labels=all'), 'all');
  assert.equal(parseLabelMode('labels=all'), 'all');
  assert.equal(parseLabelMode('#labels=smart'), 'smart');
  assert.equal(parseLabelMode('#labels=ALL<script>'), 'smart');
  assert.equal(parseLabelMode('#view=overview'), 'smart');
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

function agent(id: string, x: number, attention?: 'waiting' | 'your-turn', stuck?: boolean): LabelAgent {
  const group = new THREE.Group();
  group.position.set(x, 0, 0);
  return {
    info: { id, extras: attention || stuck ? { ...(attention ? { attention } : {}), ...(stuck ? { stuck } : {}) } : undefined },
    figure: { group, label: { element: labelElement() } },
  };
}

function controllerSetup(options: { hash?: string; viewMode?: 'first-person' | 'overview'; zoom?: number } = {}) {
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

test('controller, overview: far zoom compacts all but the waiting agent, close zoom shows all full', () => {
  const { controller, state, compact } = controllerSetup({ viewMode: 'overview' });
  controller.update(0);
  assert.deepEqual(compact(), ['near', 'far', 'mine']);
  state.zoom = zoomedIn;
  controller.update(LABEL_DETAIL_INTERVAL_MS);
  assert.deepEqual(compact(), []);
});

test('controller: updates are throttled, a forced refresh is not', () => {
  const { controller, state, compact } = controllerSetup({ viewMode: 'overview' });
  controller.update(1000);
  state.zoom = zoomedIn;
  controller.update(1000 + LABEL_DETAIL_INTERVAL_MS - 1);
  assert.deepEqual(compact(), ['near', 'far', 'mine'], 'too soon: nothing recomputed');
  controller.update(1000 + LABEL_DETAIL_INTERVAL_MS);
  assert.deepEqual(compact(), []);
});

test('controller: #labels=all keeps every label full (the old behavior)', () => {
  const { controller, compact, indicator } = controllerSetup({ hash: '#view=overview&labels=all', viewMode: 'overview' });
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
