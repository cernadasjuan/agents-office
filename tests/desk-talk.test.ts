import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { LayoutMove, LayoutStrategy, Seat } from '../src/layout/LayoutStrategy.js';

// Toon materials paint a gradient on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { AgentManager } = await import('../src/agents/AgentManager.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const TALK_SPOT: Seat = {
  key: 'desk-talk-spot',
  position: new THREE.Vector3(5, 0, 0),
  lookAt: new THREE.Vector3(5, 0, 1),
  posture: 'standing',
};

/** A minimal layout for issue #162: a fixed queue seat per agent, a controllable `isQueued`
 * set, and a `pushMove` test hook that queues a move for the next `update()` call — the same
 * shape `BuildingLayout`'s own queue refresh produces for a real reorder. */
function fakeLayout(options: { queued?: Set<string> } = {}) {
  const queued = options.queued;
  const seats = new Map<string, Seat>();
  let pending: LayoutMove[] = [];
  const layout: LayoutStrategy & { pushMove: (move: LayoutMove) => void } = {
    id: 'fake',
    seatFor: (agent, previous) => {
      if (previous !== null && seats.has(agent.id)) return null;
      const seat = seats.get(agent.id) ?? { key: `queue-${agent.id}`, position: new THREE.Vector3(0, 0, 0), lookAt: new THREE.Vector3(0, 0, 1) };
      seats.set(agent.id, seat);
      return seat;
    },
    release: () => undefined,
    update: () => {
      const moves = pending;
      pending = [];
      return moves;
    },
    deskTalkSpot: () => TALK_SPOT,
    isQueued: (agentId) => queued?.has(agentId) ?? true,
    pushMove: (move) => pending.push(move),
  };
  return layout;
}

test('selecting a queued agent in desk mode walks it to the talk spot (issue #162)', () => {
  const scene = new THREE.Scene();
  const layout = fakeLayout();
  const manager = new AgentManager(scene, layout);
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  manager.setDeskTalker('a');
  const managed = manager.getAgents().find((m) => m.info.id === 'a')!;
  assert.equal(managed.seat?.key, 'desk-talk-spot');
  assert.deepEqual(managed.seat?.position.toArray(), TALK_SPOT.position.toArray());
});

test('a second, non-queued agent never joins the talker at the desk front', () => {
  const scene = new THREE.Scene();
  const layout = fakeLayout({ queued: new Set(['a']) });
  const manager = new AgentManager(scene, layout);
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  manager.addAgent({ id: 'b', name: 'B', activity: 'implementing' });
  manager.setDeskTalker('b'); // 'b' is not in the queue: a no-op
  const b = manager.getAgents().find((m) => m.info.id === 'b')!;
  assert.notEqual(b.seat?.key, 'desk-talk-spot');
});

test('deselecting walks the talker back to its own queue seat, not a frozen stand-in', () => {
  const scene = new THREE.Scene();
  const layout = fakeLayout();
  const manager = new AgentManager(scene, layout);
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  const originalSeat = manager.getAgents()[0]!.seat;
  manager.setDeskTalker('a');
  manager.setDeskTalker(null);
  const managed = manager.getAgents().find((m) => m.info.id === 'a')!;
  assert.equal(managed.seat?.key, originalSeat?.key);
  assert.deepEqual(managed.seat?.position.toArray(), originalSeat?.position.toArray());
});

test('selecting a different queued agent releases the first one back to its queue seat', () => {
  const scene = new THREE.Scene();
  const layout = fakeLayout();
  const manager = new AgentManager(scene, layout);
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  manager.addAgent({ id: 'b', name: 'B', activity: 'idle' });
  const aQueueSeat = manager.getAgents().find((m) => m.info.id === 'a')!.seat;
  manager.setDeskTalker('a');
  manager.setDeskTalker('b');
  const a = manager.getAgents().find((m) => m.info.id === 'a')!;
  const b = manager.getAgents().find((m) => m.info.id === 'b')!;
  assert.equal(a.seat?.key, aQueueSeat?.key, 'a walked back to its own queue seat');
  assert.equal(b.seat?.key, 'desk-talk-spot', 'b is the only one at the desk front (at most one talker)');
});

test('a queue move that arrives while an agent is talking updates where it walks back to, not where it started (issue #162)', () => {
  const scene = new THREE.Scene();
  const layout = fakeLayout();
  const manager = new AgentManager(scene, layout);
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  manager.setDeskTalker('a');
  // The layout's own queue reorder moves 'a' to a different spot while it is still talking;
  // the figure itself must stay put at the desk until deselected.
  const movedSeat: Seat = { key: 'queue-a-moved', position: new THREE.Vector3(9, 0, 9), lookAt: new THREE.Vector3(9, 0, 10) };
  layout.pushMove({ agentId: 'a', seat: movedSeat });
  manager.update(0, 1 / 60);
  const stillTalking = manager.getAgents().find((m) => m.info.id === 'a')!;
  assert.equal(stillTalking.seat?.key, 'desk-talk-spot', 'the move while talking does not pull the figure back into line');

  manager.setDeskTalker(null);
  const backInLine = manager.getAgents().find((m) => m.info.id === 'a')!;
  assert.equal(backInLine.seat?.key, 'queue-a-moved', 'walks back to the new seat the queue reorder assigned, not the stale one');
});

test('without a desk to show, setDeskTalker degrades gracefully (rule 3)', () => {
  const scene = new THREE.Scene();
  const layout = fakeLayout();
  (layout as { deskTalkSpot?: () => Seat | null }).deskTalkSpot = () => null;
  const manager = new AgentManager(scene, layout);
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  const before = manager.getAgents()[0]!.seat;
  manager.setDeskTalker('a');
  const after1 = manager.getAgents()[0]!.seat;
  assert.deepEqual(after1?.key, before?.key, 'no desk to walk to: the agent stays where it was');
});
