import * as THREE from 'three';
import { createOffice } from '../src/scene/Office.js';
import { addLighting } from '../src/scene/SceneSetup.js';
import { BuildingLayout } from '../src/addons/building/BuildingLayout.js';
import { MAX_TOMBSTONES } from '../src/addons/building/missionRooms.js';
import { AgentManager } from '../src/agents/AgentManager.js';
import { bmadHats } from '../plugins/bmad/client.js';
import { GithubOfficeExtension } from '../plugins/github/client.js';
import { setFreeCameraLook } from '../src/scene/FreeCamera.js';
import { frameForBounds, overviewBounds, overviewDirection } from '../src/scene/OverviewCamera.js';
import { IsometricController } from '../src/scene/IsometricCamera.js';

/**
 * Gabriel's real size: the hall, 16 building rooms, 9 mission rooms (one locked)
 * and 40 agents. Half of the agents wear BMAD hats (one to four) and a quarter
 * wear GitHub cards (one to five), as with the fork plugins on.
 */
export const REAL_SIZE = { buildingRooms: 16, missionRooms: 9, agents: 40, hatWearers: 20, cardHolders: 10 } as const;

const PERSONAS = ['dev', 'architect', 'qa', 'pm', 'analyst', 'sm', 'debugger', 'spec-coach', 'data-engineer', 'ux-designer', 'tech-writer'];

function badgesFor(i: number): string[] | undefined {
  if (i >= REAL_SIZE.hatWearers) return undefined;
  return Array.from({ length: (i % 4) + 1 }, (_, k) => PERSONAS[(i + k * 3) % PERSONAS.length]);
}

function issuesFor(i: number): Array<{ number: number; title: string }> | undefined {
  if (i % 4 !== 1) return undefined;
  return Array.from({ length: (i % 5) + 1 }, (_, k) => ({ number: 100 + i * 10 + k, title: `issue ${k}` }));
}

/**
 * Build the office at the real size without a browser. The caller sets up a
 * jsdom `document` with a canvas stub first (toon gradients, signs, boards, cards).
 */
export function buildRealSizeOffice(): { scene: THREE.Scene; manager: AgentManager; layout: BuildingLayout; github: GithubOfficeExtension } {
  const scene = new THREE.Scene();
  addLighting(scene);
  // Per-workspace desk rooms are retired (#138): the 11 workspaces share the desk pool, the room count stays the same with plain `desks` rooms.
  const rooms = ['office', 'library', 'lounge', 'lounge', 'lounge', ...Array.from({ length: 11 }, () => 'desks')];
  const store = new Map([['agents-office.building.rooms', JSON.stringify(rooms)]]);
  const layout = new BuildingLayout(scene, createOffice(scene), {
    storage: { getItem: (key: string) => store.get(key) ?? null, setItem: () => undefined },
  });
  // Worst case: every war room at the tombstone cap, not just a handful.
  layout.syncWorldRooms(Array.from({ length: REAL_SIZE.missionRooms }, (_, i) => ({
    id: `m${i}`, kind: 'mission', title: `Mission ${i}`, state: i === 8 ? 'locked' as const : 'open' as const,
    sleepers: Array.from({ length: MAX_TOMBSTONES }, (_, j) => ({ id: `m${i}-tomb-${j}`, endedAt: '2026-11-18' })),
    walls: { statement: 'x', docs: ['a'], issues: [], kanban: [] },
  })));
  const manager = new AgentManager(scene, layout);
  for (let i = 0; i < REAL_SIZE.agents; i++) {
    manager.addAgent({
      id: `a${i}`, name: `agent ${i}`, activity: 'implementing',
      extras: { group: { id: `g${i % 11}`, label: `ws${i % 11}` }, badges: badgesFor(i), issues: issuesFor(i) },
    });
  }
  const github = new GithubOfficeExtension();
  github.start(scene);
  bmadHats.agentsChanged?.(manager.getAgents());
  github.agentsChanged(manager.getAgents());
  return { scene, manager, layout, github };
}

/** The two cameras the browser starts with: first person at its start pose, and the overview of the whole building. */
export function realSizeCameras(scene: THREE.Scene, aspect = 1280 / 800): { firstPerson: THREE.PerspectiveCamera; overview: THREE.PerspectiveCamera; isometric: THREE.OrthographicCamera } {
  const firstPerson = new THREE.PerspectiveCamera(60, aspect, 0.1, 100);
  firstPerson.position.set(-12, 5.5, 11);
  setFreeCameraLook(firstPerson, firstPerson.position, new THREE.Vector3(2, 1, -2));
  const overview = new THREE.PerspectiveCamera(60, aspect, 0.1, 200);
  const frame = frameForBounds(overviewBounds(scene), 60, aspect);
  overview.position.copy(frame.target).addScaledVector(overviewDirection(), frame.distance);
  overview.lookAt(frame.target);
  const isometric = new THREE.OrthographicCamera();
  const iso = new IsometricController();
  iso.frame(overviewBounds(scene), aspect);
  iso.applyTo(isometric, aspect, 60);
  for (const camera of [firstPerson, overview, isometric]) {
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
  }
  return { firstPerson, overview, isometric };
}
