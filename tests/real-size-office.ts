import * as THREE from 'three';
import { createOffice } from '../src/scene/Office.js';
import { addLighting } from '../src/scene/SceneSetup.js';
import { BuildingLayout } from '../src/addons/building/BuildingLayout.js';
import { AgentManager } from '../src/agents/AgentManager.js';

/** Gabriel's real size: the hall, 16 building rooms, 9 mission rooms (one locked) and 40 agents. */
export const REAL_SIZE = { buildingRooms: 16, missionRooms: 9, agents: 40 } as const;

/**
 * Build the office at the real size without a browser. The caller sets up a
 * jsdom `document` with a canvas stub first (toon gradients, signs, boards).
 */
export function buildRealSizeOffice(): { scene: THREE.Scene; manager: AgentManager; layout: BuildingLayout } {
  const scene = new THREE.Scene();
  addLighting(scene);
  const rooms = ['office', 'library', 'lounge', 'lounge', 'lounge', ...Array.from({ length: 11 }, (_, i) => `desks@ws${i}`)];
  const store = new Map([['agents-office.building.rooms', JSON.stringify(rooms)]]);
  const layout = new BuildingLayout(scene, createOffice(scene), {
    storage: { getItem: (key: string) => store.get(key) ?? null, setItem: () => undefined },
  });
  layout.syncWorldRooms(Array.from({ length: REAL_SIZE.missionRooms }, (_, i) => ({
    id: `m${i}`, kind: 'mission', title: `Mission ${i}`, state: i === 8 ? 'locked' as const : 'open' as const, sleepers: 5,
    walls: { statement: 'x', docs: ['a'], issues: [], kanban: [] },
  })));
  const manager = new AgentManager(scene, layout);
  for (let i = 0; i < REAL_SIZE.agents; i++) {
    manager.addAgent({ id: `a${i}`, name: `agent ${i}`, activity: 'implementing', extras: { group: { id: `g${i % 11}`, label: `ws${i % 11}` } } });
  }
  return { scene, manager, layout };
}
