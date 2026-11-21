import * as THREE from 'three';
import { createOffice } from '../src/scene/Office.js';
import { addLighting } from '../src/scene/SceneSetup.js';
import { BuildingLayout } from '../src/addons/building/BuildingLayout.js';
import { MAX_TOMBSTONES } from '../src/addons/building/missionRooms.js';
import { AgentManager } from '../src/agents/AgentManager.js';
import { bmadHats } from '../plugins/bmad/client.js';
import { skillsEquipment } from '../plugins/skills/client.js';
import { GithubOfficeExtension } from '../plugins/github/client.js';
import { setFreeCameraLook } from '../src/scene/FreeCamera.js';
import { overviewBounds } from '../src/scene/OverviewCamera.js';
import { IsometricController } from '../src/scene/IsometricCamera.js';

/**
 * A seeded PRNG (mulberry32), so the fixture's one source of randomness
 * (`src/furniture/Bookshelf.ts`'s book count and color, the only `Math.random`
 * call in `src` or `plugins`) draws the same sequence every run. The draw-call
 * budget test measures this fixture; an unseeded `Math.random` there made the
 * worst-case total drift between runs (issue #128 review).
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Gabriel's real size: the hall, 16 building rooms, 9 mission rooms (one locked)
 * and 40 agents. Half of the agents wear BMAD hats (one to four) and a quarter
 * wear GitHub cards (one to five), as with the fork plugins on.
 */
export const REAL_SIZE = { buildingRooms: 16, missionRooms: 9, agents: 40, hatWearers: 20, cardHolders: 10 } as const;

// 'librarian' included (issue #128 review): the budget fixture must wear every hat it pins.
const PERSONAS = ['dev', 'architect', 'qa', 'pm', 'analyst', 'sm', 'debugger', 'spec-coach', 'data-engineer', 'ux-designer', 'tech-writer', 'librarian'];

function badgesFor(i: number): string[] | undefined {
  if (i >= REAL_SIZE.hatWearers) return undefined;
  return Array.from({ length: (i % 4) + 1 }, (_, k) => PERSONAS[(i + k * 3) % PERSONAS.length]);
}

function issuesFor(i: number): Array<{ number: number; title: string }> | undefined {
  if (i % 4 !== 1) return undefined;
  return Array.from({ length: (i % 5) + 1 }, (_, k) => ({ number: 100 + i * 10 + k, title: `issue ${k}` }));
}

/**
 * Issue #167 v1 (skills equipment): a sequence that cycles through every hand-item
 * kind this catalog maps (one per `HAND_MAP` entry, plus the unmapped-skill toolbox
 * fallback), and both face items (`glasses`, from 2+ skills; `headphones`, from a
 * dedicated skill) — so the budget fixture's worst case actually pins the real
 * bucket count this feature spends, not an undercount from a fixture that never
 * wears any of it. Every 6th agent carries no skills at all, the same "not every
 * agent wears one" shape `badgesFor` already follows.
 */
const SKILL_SEQUENCES: string[][] = [
  ['git'],
  ['jira'],
  ['klever-mr'],
  ['crit:crit'],
  ['code-review'],
  ['bibliotheque-librarian'],
  ['dataviz'],
  ['research'],
  ['investigate'],
  ['totally-unmapped-skill'],
  ['git', 'jira'],
  ['klever-test'],
  ['git', 'klever-test'],
];

function skillsFor(i: number): string[] | undefined {
  if (i % 6 === 5) return undefined;
  return SKILL_SEQUENCES[i % SKILL_SEQUENCES.length];
}

/**
 * Round 2 (issue #167): the raw built-in tool allow-list (`plugins/skills/index.ts`'s
 * `TOOL_ALLOWLIST`), cycled the same way `SKILL_SEQUENCES` is, so this fixture's worst
 * case also pins the 3 new buckets this round actually spends (`terminal-screen`,
 * `pencil`, `globe` — `magnifier` and `open-book` are reused from the skills side, no
 * new bucket). `lastEquipSourceFor` alternates which list actually wins the hand slot
 * (`handItemFor`'s own tie-break otherwise always prefers `skills` when both are
 * present), so both the tool-triggered and the skill-triggered items are exercised,
 * not just whichever the default preference always picks.
 */
const TOOL_SEQUENCES: string[][] = [['Bash'], ['Grep'], ['Glob'], ['Read'], ['Edit'], ['Write'], ['WebSearch'], ['WebFetch'], ['Task']];

function toolsFor(i: number): string[] {
  return TOOL_SEQUENCES[i % TOOL_SEQUENCES.length];
}

/**
 * Review (issue #167 round 2): alternating on `i % 2` let `code-review`'s loupe silently
 * never win the hand slot — its only two non-suppressed occurrences (agents 4 and 30,
 * `SKILL_SEQUENCES[4]`) both landed on the `i % 2 === 0` ("tool wins") side, so the fixture
 * never actually equipped it despite the comment above claiming full coverage. Alternating
 * on which full lap of `SKILL_SEQUENCES` this agent falls in, instead of on the agent's own
 * index, guarantees every sequence's first lap (agents 0-12, repeat 0) wins the hand slot
 * via `skill` before any `tool` override can suppress it — the fixture's worst case must
 * equip every mapped kind at least once, not just the ones a lucky index happens to land on.
 */
function lastEquipSourceFor(i: number): 'skill' | 'tool' | undefined {
  if (!skillsFor(i)) return 'tool';
  const lap = Math.floor(i / SKILL_SEQUENCES.length);
  return lap % 2 === 0 ? 'skill' : 'tool';
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
  // Seeded for the room build only (the library's bookshelves): deterministic book
  // count and color, so the draw-call budget test measures the same scene every time.
  const realRandom = Math.random;
  Math.random = seededRandom(163);
  let layout: BuildingLayout;
  try {
    layout = new BuildingLayout(scene, createOffice(scene), {
      storage: { getItem: (key: string) => store.get(key) ?? null, setItem: () => undefined },
    });
  } finally {
    Math.random = realRandom;
  }
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
      extras: {
        group: { id: `g${i % 11}`, label: `ws${i % 11}` }, badges: badgesFor(i), issues: issuesFor(i),
        skills: skillsFor(i), tools: toolsFor(i), lastEquipSource: lastEquipSourceFor(i),
      },
    });
  }
  // Worst case for war-room furniture: push every open mission room past its desk cap
  // (half debugging, half other desk-like work) at least once. Growth persists at its
  // peak even after these agents leave, so the budget test sees the heaviest room.
  for (let room = 0; room < REAL_SIZE.missionRooms - 1; room++) {
    const stressIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = `stress-${room}-${i}`;
      stressIds.push(id);
      manager.addAgent({ id, name: id, activity: i < 4 ? 'debugging' : 'implementing', extras: { room: `m${room}` } });
    }
    layout.update();
    for (const id of stressIds) manager.removeAgent(id);
  }
  const github = new GithubOfficeExtension();
  github.start(scene);
  bmadHats.agentsChanged?.(manager.getAgents());
  skillsEquipment.agentsChanged?.(manager.getAgents());
  github.agentsChanged(manager.getAgents());
  return { scene, manager, layout, github };
}

/** The two modes the browser starts with (#173 dropped the overview mode): first person at its start pose, and the isometric view of the whole building. */
export function realSizeCameras(scene: THREE.Scene, aspect = 1280 / 800): { firstPerson: THREE.PerspectiveCamera; isometric: THREE.OrthographicCamera } {
  const firstPerson = new THREE.PerspectiveCamera(60, aspect, 0.1, 100);
  firstPerson.position.set(-12, 5.5, 11);
  setFreeCameraLook(firstPerson, firstPerson.position, new THREE.Vector3(2, 1, -2));
  const isometric = new THREE.OrthographicCamera();
  const iso = new IsometricController();
  iso.frame(overviewBounds(scene), aspect);
  iso.applyTo(isometric, aspect, 60);
  for (const camera of [firstPerson, isometric]) {
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
  }
  return { firstPerson, isometric };
}
