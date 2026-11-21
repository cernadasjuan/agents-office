import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import {
  FIRST_PERSON_FULL_LABEL_DISTANCE,
  LABEL_DETAIL_INTERVAL_MS,
  LabelDetailController,
  ISOMETRIC_FULL_LABEL_ZOOM,
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
const zoomedIn = ISOMETRIC_FULL_LABEL_ZOOM - 1;
const zoomedOut = ISOMETRIC_FULL_LABEL_ZOOM + 10;

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
  assert.equal(labelDetail(facts(), view({ viewMode: 'isometric', zoomDistance: ISOMETRIC_FULL_LABEL_ZOOM })), 'full');
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

function controllerSetup(options: { hash?: string; viewMode?: 'first-person' | 'isometric'; zoom?: number; onHoverHint?: (hint: string | null, point: { x: number; y: number } | null) => void } = {}) {
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
    onHoverHint: options.onHoverHint,
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

// --- The beacon hint on hover (issue #170 review): labels have pointer-events none, so a
// title attribute there never shows. This reuses the same hover detection as label declutter. ---

test('hovering an agent that calls for you reports the beacon hint and the cursor position', () => {
  const calls: Array<[string | null, { x: number; y: number } | null]> = [];
  const { controller, canvas, state } = controllerSetup({ onHoverHint: (hint, point) => calls.push([hint, point]) });
  state.picked = 'blocked';
  canvas.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 42, clientY: 24 }));
  controller.refresh();
  const [hint, point] = calls[calls.length - 1];
  assert.ok(hint && hint.length > 0, 'the agent calls for you (a block, no wait time keeps the old behavior): a hint is reported');
  assert.deepEqual(point, { x: 42, y: 24 });
});

test('hovering an agent that does not call for you reports no hint', () => {
  const calls: Array<[string | null, { x: number; y: number } | null]> = [];
  const { controller, canvas, state } = controllerSetup({ onHoverHint: (hint, point) => calls.push([hint, point]) });
  state.picked = 'near';
  canvas.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 5, clientY: 5 }));
  controller.refresh();
  assert.deepEqual(calls[calls.length - 1], [null, null]);
});

test('pointer lock clears the tooltip at once, and a frozen-coordinate move while locked never brings it back (review fix)', () => {
  const calls: Array<[string | null, { x: number; y: number } | null]> = [];
  const { controller, canvas, state } = controllerSetup({ onHoverHint: (hint, point) => calls.push([hint, point]) });
  try {
    // Hover a calls-for-you agent before any lock: the hint shows, as the earlier test proves.
    state.picked = 'blocked';
    canvas.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 42, clientY: 24 }));
    controller.refresh();
    assert.ok(calls[calls.length - 1][0], 'the hint shows before any lock, same as the unlocked case above');

    // The lock engages with no further pointer event at all: the change handler alone, not a
    // later refresh, must clear it at once.
    Object.defineProperty(canvas.ownerDocument, 'pointerLockElement', { value: canvas, configurable: true });
    canvas.ownerDocument.dispatchEvent(new dom.window.Event('pointerlockchange'));
    assert.deepEqual(calls[calls.length - 1], [null, null], 'the lock handler itself hides the tooltip, before any refresh runs');

    // A refresh afterward must not resurrect it either.
    controller.refresh();
    assert.deepEqual(calls[calls.length - 1], [null, null]);

    // A locked pointer keeps firing pointermove with the same frozen pre-lock coordinates in a
    // real browser (the look deltas travel in movementX/movementY instead): this must never
    // revive the stale cursor position.
    canvas.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 42, clientY: 24 }));
    controller.refresh();
    assert.deepEqual(calls[calls.length - 1], [null, null], 'a locked pointermove at the old coordinates never brings the tooltip back');
  } finally {
    Object.defineProperty(canvas.ownerDocument, 'pointerLockElement', { value: null, configurable: true });
  }
});

test('the beacon tooltip still works in #labels=all mode (review fix): the hover hint is not smart-only', () => {
  const calls: Array<[string | null, { x: number; y: number } | null]> = [];
  const { controller, canvas, state } = controllerSetup({ hash: '#labels=all', onHoverHint: (hint, point) => calls.push([hint, point]) });
  assert.equal(controller.mode, 'all');
  state.picked = 'blocked';
  canvas.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 7, clientY: 9 }));
  controller.refresh();
  const [hint, point] = calls[calls.length - 1];
  assert.ok(hint && hint.length > 0, 'the hint still reaches the cursor in all-labels mode, even though declutter stays smart-only');
  assert.deepEqual(point, { x: 7, y: 9 });
});

test('without a hover, no hint is reported even while an agent calls for you elsewhere', () => {
  const calls: Array<[string | null, { x: number; y: number } | null]> = [];
  const { controller } = controllerSetup({ onHoverHint: (hint, point) => calls.push([hint, point]) });
  controller.update(0);
  assert.deepEqual(calls[calls.length - 1], [null, null]);
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

function declutterSetup(options: { hash?: string; viewMode?: 'first-person' | 'isometric' | 'desk'; zoom?: number; deskMonitorCorners?: () => THREE.Vector3[][]; picked?: string | null } = {}) {
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
  const state = { viewMode: options.viewMode ?? 'isometric', zoom: options.zoom ?? 0, selected: null as string | null, picked: (options.picked ?? null) as string | null };
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
    deskMonitorCorners: options.deskMonitorCorners,
  });
  return { controller, agents, state, canvas, camera };
}

/** A square quad in front of the test camera, centered at `(x, y, 0)`, half-width `half` (issue #161 review, defect 4). */
function monitorQuad(x: number, y: number, half = 1): THREE.Vector3[] {
  return [
    new THREE.Vector3(x - half, y - half, 0),
    new THREE.Vector3(x + half, y - half, 0),
    new THREE.Vector3(x + half, y + half, 0),
    new THREE.Vector3(x - half, y + half, 0),
  ];
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

// --- Issue #161 review, defect 4: desk mode declutters too, and keeps the desk monitors clear ---

test('declutter: runs in desk mode too, not just isometric', () => {
  const { controller, agents } = declutterSetup({ viewMode: 'desk' });
  agents.push(agent('working', 0), agent('aging-wait', 0, 'waiting', false, 60));
  controller.update(0);
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), ['working'], 'desk mode now declutters overlapping labels the same as isometric');
});

test('declutter: in desk mode, a label covering a monitor hides even with a clear screen spot of its own', () => {
  // The lone agent would normally survive (its own test above, "a clear screen spot"):
  // nothing else overlaps it. A monitor sitting at the same screen spot still hides it.
  const { controller, agents } = declutterSetup({ viewMode: 'desk', deskMonitorCorners: () => [monitorQuad(0, 2.1)] });
  agents.push(agent('alone', 0));
  controller.update(0);
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), ['alone'], 'the label sits on top of the monitor, so it hides despite having the screen to itself');
});

test('declutter: in desk mode, a label clear of every monitor stays visible', () => {
  const { controller, agents } = declutterSetup({ viewMode: 'desk', deskMonitorCorners: () => [monitorQuad(0, 2.1)] });
  agents.push(agent('far-away', -8));
  controller.update(0);
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), [], 'this agent projects well clear of the monitor rect');
});

test('declutter: in desk mode, the selected agent stays visible even covering a monitor', () => {
  const { controller, agents, state } = declutterSetup({ viewMode: 'desk', deskMonitorCorners: () => [monitorQuad(0, 2.1)] });
  agents.push(agent('selected-one', 0));
  state.selected = 'selected-one';
  controller.update(0);
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), [], 'selected wins over the monitor obstruction, the same exception label-on-label overlap already gives it');
});

test('declutter: a monitor with a corner off the frustum protects nothing (never a wrong rect)', () => {
  // A corner far behind the camera: `projectToScreen` returns null for it, so the whole quad
  // is skipped rather than building a screen rect from the three corners that did project.
  const { controller, agents } = declutterSetup({
    viewMode: 'desk',
    deskMonitorCorners: () => [[new THREE.Vector3(-1, 1, 0), new THREE.Vector3(1, 1, 0), new THREE.Vector3(1, -1, 0), new THREE.Vector3(-1, -1, -1000)]],
  });
  agents.push(agent('alone', 0));
  controller.update(0);
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), [], 'an off-frustum monitor corner means no obstruction rect, not a wrong one');
});

test('declutter: without a deskMonitorCorners option at all, desk mode still declutters, just protects no monitor', () => {
  const { controller, agents } = declutterSetup({ viewMode: 'desk' });
  agents.push(agent('alone', 0));
  controller.update(0);
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), [], 'no monitors to protect, so nothing new hides');
});

test('declutter: a long name\'s real rendered width can overlap a neighbor the fixed estimate alone would miss (review fix)', () => {
  // Zoomed out, so labels go compact (zoom <= ISOMETRIC_FULL_LABEL_ZOOM would force full and
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

// --- Review fix round (issue #168, from the #152 review comment) ---

test('declutter: a point closer than the near plane is never a candidate either, the same as one behind the camera (review fix)', () => {
  const { controller, agents, camera } = declutterSetup();
  const nearPlane = (camera as THREE.PerspectiveCamera).near;
  // Ahead of the camera (it looks toward -z from z=30) but closer than the near plane: the
  // renderer clips it there too, and the projection math right at that plane is unreliable.
  const tooClose = agent('too-close', 0, 'waiting', false, 1);
  tooClose.figure.group.position.set(0, 0, 30 - nearPlane / 2);
  agents.push(agent('plain', 0), tooClose);
  controller.update(0);
  controller.refresh();
  assert.deepEqual(hiddenIds(agents), ['too-close'], 'never drawn on screen anyway, so its own label hides; "plain" is never hidden by it');
});

test('declutter: every label\'s class write happens before any getBoundingClientRect read, so one refresh forces one layout pass, not one per agent (review fix)', () => {
  const { controller, agents } = declutterSetup({ zoom: zoomedOut });
  agents.push(agent('a', 0), agent('b', 4));
  const order: string[] = [];
  for (const a of agents) {
    const el = a.figure.label.element;
    const originalToggle = el.classList.toggle.bind(el.classList);
    el.classList.toggle = ((...args: Parameters<typeof originalToggle>) => {
      order.push(`write:${a.info.id}`);
      return originalToggle(...args);
    }) as typeof el.classList.toggle;
    const originalRect = el.getBoundingClientRect.bind(el);
    el.getBoundingClientRect = () => {
      order.push(`read:${a.info.id}`);
      return originalRect();
    };
  }
  controller.update(0);
  controller.refresh();
  const firstRead = order.findIndex((entry) => entry.startsWith('read:'));
  const lastWrite = order.reduce((last, entry, index) => (entry.startsWith('write:') ? index : last), -1);
  assert.ok(order.some((entry) => entry.startsWith('write:')), `at least one write happened: ${order.join(', ')}`);
  assert.ok(order.some((entry) => entry.startsWith('read:')), `at least one read happened: ${order.join(', ')}`);
  assert.ok(lastWrite < firstRead, `every write finishes before any read: ${order.join(', ')}`);
});
