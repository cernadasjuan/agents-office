import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { registerExtension, type OfficeExtension, type World, type WorldLibrarySection } from '../../src/extensions.js';
import { ALL_FLOORS, matchesFloor } from '../../src/floors/FloorRegistry.js';
import { focusedFloor } from '../../src/floors/floorState.js';
import { ROOM_SIZE, slotFor, type Door, type Rect, type Side } from '../../src/addons/building/RoomPlanner.js';

/**
 * Library shelves (issue #191 AC1, #119): a self-contained extension that attaches to whatever
 * library room the building layout already built, the same pattern `plugins/jira/client.ts`
 * uses for its office board. Degrades to nothing without the room in the scene (another
 * layout, or the building has not grown a library yet — it always does, but this never
 * assumes it), or without any library at all in `/api/world`. On a specific focused floor,
 * only that floor's own matching library shows (`matchesFloor`). On `ALL_FLOORS` (the default
 * view every cold start lands on), there is no single floor to key one off: with exactly one
 * library configured this shows it anyway rather than hiding the feature behind a floor
 * switch; with more than one, every library's sections list together (still capped the same
 * way).
 */

/** The library's own group name, whatever index it actually rented at (`rooms.ts`'s
 * `buildRoom`: `room-${index}-${kind}`). `BuildingLayout`'s constructor force-adds a missing
 * library early, so it is almost always index 1, right after the office — but a floor whose
 * room list already existed before the library was always forced to exist can have it land at
 * a later index within the first ring (review round 1: a hardcoded `room-1-library` matched
 * nothing there, silently showing no shelves). This reads the room's real index back out of
 * its own name instead of assuming one. */
const LIBRARY_ROOM_PATTERN = /^room-(\d+)-library$/;

function findLibraryRoomIndex(scene: THREE.Scene): number | undefined {
  for (const child of scene.children) {
    const match = LIBRARY_ROOM_PATTERN.exec(child.name);
    if (match) return Number(match[1]);
  }
  return undefined;
}

const INWARD_BY_SIDE: Record<Side, [number, number]> = { west: [1, 0], east: [-1, 0], north: [0, 1], south: [0, -1] };

/**
 * A room's own door-wall-center point, `along` and `inward` directions, duplicated from
 * `rooms.ts`'s own `RoomFrame` (plain number math, no THREE needed for it): a plugin's client
 * extension stays self-contained rather than importing the room-building module's full THREE
 * dependency graph (toon materials, static-merge zones, furnishing plans) for one formula —
 * the same reason `server/floor.ts` keeps its own copy of `plugins/peek/transcript.ts`'s
 * `worktreeMain` instead of importing across that core/plugin boundary. `d` is the depth from
 * the door wall into the room, `a` runs along it; see `rooms.ts`'s own doc comment on `RoomFrame`.
 */
function shelfPoint(rect: Rect, door: Door, a: number, d: number, y: number): [number, number, number] {
  const [nx, nz] = INWARD_BY_SIDE[door.side];
  const doorWallX = (rect.minX + rect.maxX) / 2 - (nx * ROOM_SIZE) / 2;
  const doorWallZ = (rect.minZ + rect.maxZ) / 2 - (nz * ROOM_SIZE) / 2;
  return [doorWallX + -nz * a + nx * d, y, doorWallZ + nx * a + nz * d];
}

/**
 * `d = 11.5` is the far wall, the same depth `furnishLibrary` already shelves at; `a` in
 * `[-1.3, 0, 1.3]` sits inside the open middle gap that plan leaves on purpose (its own
 * shelves sit off-center at `a = +/-2.2` and `+/-3.9`), so a sign never shares wall space with
 * a shelf. Both are the furnishing plan's own choice, not the slot's — they hold regardless of
 * which first-ring rect/door the library actually rented.
 */
const SIGN_DEPTH = 11.5;
const SIGN_Y = 1.9;
const SIGN_ALONGS = [-1.3, 0, 1.3];
const MAX_SECTIONS_SHOWN = SIGN_ALONGS.length;
const MAX_ENTRY_LINES = 4;

/**
 * Round 7 feedback (#214): these labels "fade in and out depending on where I put my mouse"
 * (Gabriel, verbatim) and he'd like to read them without hovering. They used the war-room-sign
 * system (`LabelDetail.ts`'s `signVisible`), built for a sign you glance at from across a
 * floor, not a wall label you read while standing near it: `hoverOnly` gates on a floor
 * raycast under the mouse, which a natural reading angle (looking up at a shelf, not down at
 * the floor) usually misses entirely, and the default first-person sign distance (12 units)
 * sits inside the room's own depth, so the far-wall shelves fade as soon as you're not right
 * on top of them. Neither label needs hovering here — `maxDistance` covers the room's full
 * diagonal from any standing point instead of the shorter default.
 */
const LIBRARY_SIGN_MAX_DISTANCE = 20;

function plaqueElement(section: WorldLibrarySection): HTMLDivElement {
  const element = document.createElement('div');
  element.textContent = section.name;
  Object.assign(element.style, {
    background: 'rgba(90, 74, 58, 0.9)', color: '#f5f0e8', padding: '2px 8px', borderRadius: '4px',
    font: '600 13px system-ui, sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none',
  });
  return element;
}

function boardElement(section: WorldLibrarySection): HTMLDivElement {
  const element = document.createElement('div');
  Object.assign(element.style, {
    background: 'rgba(247, 243, 234, 0.95)', color: '#2a2a3e', padding: '4px 8px', borderRadius: '4px',
    font: '12px system-ui, sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none', textAlign: 'left',
  });
  for (const entry of section.entries.slice(0, MAX_ENTRY_LINES)) {
    const line = document.createElement('div');
    line.textContent = entry.archived ? `${entry.title} (archived)` : entry.title;
    if (entry.archived) line.style.opacity = '0.65';
    element.appendChild(line);
  }
  // `section.truncated` is the server's own cap (more rows exist in the section's INDEX.md
  // than `MAX_ENTRIES` carries); a section within that cap can still carry more entries than
  // this board's own `MAX_ENTRY_LINES` shows (review: a 5- or 6-entry section silently lost
  // its last rows here with no notice at all, archived entries among them).
  if (section.truncated || section.entries.length > MAX_ENTRY_LINES) {
    const more = document.createElement('div');
    more.textContent = '…more on this shelf';
    more.style.opacity = '0.65';
    element.appendChild(more);
  }
  return element;
}

interface MountedShelf {
  plaque: CSS2DObject;
  board: CSS2DObject;
}

export class FloorLibraryOfficeExtension implements OfficeExtension {
  readonly id = 'floor-library-shelves';
  readonly plugin = 'floor-library';
  private scene: THREE.Scene | null = null;
  private shelves: MountedShelf[] = [];
  private signature = '';
  private slot: { rect: Rect; door: Door } | null = null;

  start(scene: THREE.Scene): void {
    this.scene = scene;
  }

  worldChanged(world: World): void {
    if (!this.scene) return;
    const floor = focusedFloor();
    const libraries = world.libraries ?? [];
    // `ALL_FLOORS` has no single floor to key "the focused floor's library" off. With exactly
    // one library configured (today: the Klever project-management root, the only one that
    // exists) that is no longer an ambiguity, so it shows there too — the office opens on
    // `ALL_FLOORS` every cold start (`defaultFloor`, `src/floors/FloorRegistry.ts`), and
    // showing nothing there made the feature invisible unless Gabriel switched floors first.
    // With more than one library, this lists every one's sections rather than guess which
    // floor matters most; `MAX_SECTIONS_SHOWN` still bounds what actually mounts.
    const matched = floor === ALL_FLOORS
      ? (libraries.length === 1 ? libraries[0].sections : libraries.flatMap((candidate) => candidate.sections))
      : libraries.find((candidate) => matchesFloor(floor, candidate.repo))?.sections;
    const roomIndex = findLibraryRoomIndex(this.scene);
    this.slot = roomIndex === undefined ? null : slotFor(roomIndex);
    const sections = this.slot && matched ? matched.slice(0, MAX_SECTIONS_SHOWN) : [];
    const signature = `${roomIndex}:${JSON.stringify(sections)}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.unmountAll();
    sections.forEach((section, index) => this.mount(section, index));
  }

  private mount(section: WorldLibrarySection, index: number): void {
    const along = SIGN_ALONGS[index];
    if (along === undefined || !this.scene || !this.slot) return;
    const { rect, door } = this.slot;
    const position = shelfPoint(rect, door, along, SIGN_DEPTH, SIGN_Y);
    const plaque = new CSS2DObject(plaqueElement(section));
    plaque.position.set(position[0], position[1] + 0.5, position[2]);
    plaque.userData.detailSign = { rect, hoverOnly: false, maxDistance: LIBRARY_SIGN_MAX_DISTANCE };
    plaque.userData.shelfRole = 'plaque';
    const board = new CSS2DObject(boardElement(section));
    board.position.set(...position);
    // Round 7 (#214): no longer hover-only — Gabriel wants to read the file list without
    // hunting for the one mouse position that triggers it. Clicking to expand stays a
    // separate, later spike.
    board.userData.detailSign = { rect, hoverOnly: false, maxDistance: LIBRARY_SIGN_MAX_DISTANCE };
    board.userData.shelfRole = 'board';
    this.scene.add(plaque, board);
    this.shelves.push({ plaque, board });
  }

  private unmountAll(): void {
    for (const shelf of this.shelves) {
      shelf.plaque.removeFromParent();
      shelf.board.removeFromParent();
    }
    this.shelves = [];
  }
}

registerExtension(new FloorLibraryOfficeExtension());
